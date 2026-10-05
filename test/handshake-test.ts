// End-to-end Noise handshake against a mock server that mirrors the WhatsApp
// server side of the protocol. Exercises the real socket client over a real
// websocket: client hello -> server hello + cert chain -> client finish ->
// transport, then a pair-device IQ to drive the QR flow.
import { WebSocketServer } from 'ws'
import { Curve, sha256, hkdf, aesEncryptGCM, aesDecryptGCM } from '../src/crypto/index.js'
import { encodeCertChain, encodeNoiseCertificateDetails } from '../src/proto/cert-chain.js'
import { decodeClientPayload } from '../src/proto/client-payload.js'
import { decodeHandshakeMessage, encodeHandshakeMessage } from '../src/proto/handshake.js'
import { encodeBinaryNode } from '../src/wabinary/encode.js'
import { WAClient } from '../src/socket/client.js'
import { initAuthState } from '../src/utils/auth-utils.js'

let pass = 0
let total = 0
const check = (label, cond, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const EMPTY = Buffer.alloc(0)
const HEADER = Buffer.from([87, 65, 6, 3])

const iv = c => {
  const b = Buffer.alloc(12)
  b.writeUInt32BE(c >>> 0, 8)
  return b
}
const frame3 = data => {
  const b = Buffer.alloc(3)
  b.writeUIntBE(data.length, 0, 3)
  return Buffer.concat([b, data])
}

// Mirror of the server side of the WhatsApp Noise_XX_25519_AESGCM_SHA256 flow.
class ServerNoise {
  constructor() {
    const d = Buffer.from('Noise_XX_25519_AESGCM_SHA256\0\0\0\0')
    this.hash = d.length === 32 ? d : sha256(d)
    this.salt = this.hash
    this.encKey = this.hash
    this.decKey = this.hash
  }
  hash
  salt
  encKey
  decKey
  counter = 0
  transport = null
  readCounter = 0
  writeCounter = 0

  authenticate(data) {
    if (!this.transport) this.hash = sha256(Buffer.concat([Buffer.from(this.hash), Buffer.from(data)]))
  }
  mix(data) {
    const key = hkdf(data, 64, { salt: this.salt, info: '' })
    this.salt = key.subarray(0, 32)
    this.encKey = key.subarray(32)
    this.decKey = key.subarray(32)
    this.counter = 0
  }
  encrypt(pt) {
    if (this.transport) return aesEncryptGCM(pt, this.transport.write, iv(this.writeCounter++), EMPTY)
    const r = aesEncryptGCM(pt, this.encKey, iv(this.counter++), this.hash)
    this.authenticate(r)
    return r
  }
  decrypt(ct) {
    if (this.transport) return aesDecryptGCM(ct, this.transport.read, iv(this.readCounter++), EMPTY)
    const r = aesDecryptGCM(ct, this.decKey, iv(this.counter++), this.hash)
    this.authenticate(ct)
    return r
  }
  finishInit() {
    const key = hkdf(EMPTY, 64, { salt: this.salt, info: '' })
    // Server writes with key[32:], reads with key[0:32] (client is the mirror).
    this.transport = { write: key.subarray(32), read: key.subarray(0, 32) }
  }
}

const runServer = (wss, ctx) => {
  const ca = ctx.ca
  wss.on('connection', ws => {
    const serverStatic = Curve.generateKeyPair()
    const serverEphemeral = Curve.generateKeyPair()
    const intermediate = Curve.generateKeyPair()
    const noise = new ServerNoise()
    let stage = 0

    ws.on('message', raw => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)

      if (stage === 0) {
        const hello = decodeHandshakeMessage(buf.subarray(7))
        const clientEphemeral = Buffer.from(hello.clientHello.ephemeral)

        noise.authenticate(HEADER)
        noise.authenticate(clientEphemeral)
        noise.authenticate(serverEphemeral.public)
        noise.mix(Curve.sharedKey(serverEphemeral.private, clientEphemeral))

        const staticEnc = noise.encrypt(serverStatic.public)
        noise.mix(Curve.sharedKey(serverStatic.private, clientEphemeral))

        const leafDetails = encodeNoiseCertificateDetails({ serial: 1, issuerSerial: 0, key: serverStatic.public, notBefore: 0n, notAfter: 0n })
        const intermediateDetails = encodeNoiseCertificateDetails({ serial: 0, issuerSerial: 0, key: intermediate.public, notBefore: 0n, notAfter: 0n })
        const chain = encodeCertChain({
          leaf: { details: leafDetails, signature: Curve.sign(intermediate.private, leafDetails) },
          intermediate: { details: intermediateDetails, signature: Curve.sign(ca.private, intermediateDetails) }
        })
        const certEnc = noise.encrypt(chain)

        const serverHello = encodeHandshakeMessage({
          serverHello: { ephemeral: serverEphemeral.public, static: staticEnc, payload: certEnc }
        })
        ws.send(frame3(serverHello))
        stage = 1
        return
      }

      if (stage === 1) {
        const finish = decodeHandshakeMessage(buf.subarray(3))
        const clientStatic = Buffer.from(noise.decrypt(finish.clientFinish.static))
        noise.mix(Curve.sharedKey(serverEphemeral.private, clientStatic))
        const payload = decodeClientPayload(noise.decrypt(finish.clientFinish.payload))
        ctx.clientStatic = clientStatic
        ctx.payload = payload
        check('server opens client finish', true)
        check('payload is registration', !!payload.devicePairingData, JSON.stringify(Object.keys(payload)))
        check('eIdent is 32 bytes (raw identity key)', payload.devicePairingData?.eIdent?.length === 32)
        noise.finishInit()
        stage = 2

        const pairDeviceIq = {
          tag: 'iq',
          attrs: { type: 'set', id: 'pair-1' },
          content: [{ tag: 'pair-device', attrs: {}, content: [{ tag: 'ref', attrs: {}, content: Buffer.from('REF-123') }] }]
        }
        ws.send(frame3(noise.encrypt(encodeBinaryNode(pairDeviceIq))))
        return
      }

      const size = buf.readUIntBE(0, 3)
      const nodeBuf = noise.decrypt(buf.subarray(3, size + 3))
      ctx.transportNode = nodeBuf
      check('server decrypts transport node', nodeBuf.length > 0)
    })
  })
}

const waitFor = (client, predicate, timeout = 6000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for event')), timeout)
    client.ev.on('connection.update', update => {
      if (predicate(update)) {
        clearTimeout(timer)
        resolve(update)
      }
    })
  })

const main = async () => {
  const ca = Curve.generateKeyPair()
  const ctx = { ca }
  const wss = new WebSocketServer({ port: 0 })
  await new Promise(res => wss.on('listening', res))
  const port = wss.address().port
  runServer(wss, ctx)

  const auth = initAuthState()
  const client = new WAClient({
    waWebSocketUrl: `ws://127.0.0.1:${port}`,
    origin: 'https://web.whatsapp.com',
    auth,
    qrTimeout: 150,
    logger: {
      level: 'trace',
      trace: (o, m) => console.log('[trace]', m, o?.tag ?? ''),
      debug: (o, m) => console.log('[debug]', m),
      info: (o, m) => console.log('[info]', m),
      warn: (o, m) => console.log('[warn]', m, o),
      error: (o, m) => console.log('[error]', m, o)
    },
    noiseCertPublicKey: ca.public,
    noiseCertSerial: 0
  })
  client.ev.on('connection.update', u => console.log('[conn]', JSON.stringify({ ...u, qr: u.qr ? '<qr>' : undefined, lastDisconnect: u.lastDisconnect?.error?.message })))

  const qrPromise = waitFor(client, u => !!u.qr)
  client.connect()
  const qrUpdate = await qrPromise

  check('client completes handshake (registration payload)', !!ctx.payload?.devicePairingData)
  check('client static is 32 bytes', ctx.clientStatic?.length === 32)
  check('client static equals creds.noiseKey.public', Buffer.from(ctx.clientStatic ?? []).equals(Buffer.from(auth.creds.noiseKey.public)))
  check('QR emitted', typeof qrUpdate.qr === 'string' && qrUpdate.qr.startsWith('https://wa.me/settings/linked_devices#'))
  check('QR contains ref', qrUpdate.qr.includes('REF-123'))

  await client.close()
  wss.close()
  await new Promise(r => setTimeout(r, 100))

  console.log(`\n${pass}/${total} handshake integration checks passed`)
if (pass !== total) process.exitCode = 1
  process.exit(pass === total ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
