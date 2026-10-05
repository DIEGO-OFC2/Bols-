// Shared mock of the WhatsApp server side of the Noise handshake and transport.
// Used by the integration tests so they can drive the real socket client.
import { Curve, sha256, hkdf, aesEncryptGCM, aesDecryptGCM } from '../src/crypto/index.js'
import { encodeCertChain, encodeNoiseCertificateDetails } from '../src/proto/cert-chain.js'
import { decodeClientPayload } from '../src/proto/client-payload.js'
import { decodeHandshakeMessage, encodeHandshakeMessage } from '../src/proto/handshake.js'
import { encodeBinaryNode } from '../src/wabinary/encode.js'
import { decodeBinaryNode } from '../src/wabinary/decode.js'
import type { BinaryNode } from '../src/wabinary/types.js'

export const EMPTY = Buffer.alloc(0)
export const HEADER = Buffer.from([87, 65, 6, 3])

export const iv = (c: number) => {
  const b = Buffer.alloc(12)
  b.writeUInt32BE(c >>> 0, 8)
  return b
}

export const frame3 = (data: Buffer) => {
  const b = Buffer.alloc(3)
  b.writeUIntBE(data.length, 0, 3)
  return Buffer.concat([b, data])
}

// Mirror of the server side of the WhatsApp Noise_XX_25519_AESGCM_SHA256 flow.
export class ServerNoise {
  hash: Buffer
  salt: Buffer
  encKey: Buffer
  decKey: Buffer
  counter = 0
  transport: { write: Buffer; read: Buffer } | null = null
  readCounter = 0
  writeCounter = 0

  constructor() {
    const d = Buffer.from('Noise_XX_25519_AESGCM_SHA256\0\0\0\0')
    this.hash = d.length === 32 ? d : sha256(d)
    this.salt = this.hash
    this.encKey = this.hash
    this.decKey = this.hash
  }

  authenticate(data: Buffer) {
    if (!this.transport) this.hash = sha256(Buffer.concat([Buffer.from(this.hash), Buffer.from(data)]))
  }
  mix(data: Buffer) {
    const key = hkdf(data, 64, { salt: this.salt, info: '' })
    this.salt = key.subarray(0, 32)
    this.encKey = key.subarray(32)
    this.decKey = key.subarray(32)
    this.counter = 0
  }
  encrypt(pt: Buffer) {
    if (this.transport) return aesEncryptGCM(pt, this.transport.write, iv(this.writeCounter++), EMPTY)
    const r = aesEncryptGCM(pt, this.encKey, iv(this.counter++), this.hash)
    this.authenticate(r)
    return r
  }
  decrypt(ct: Buffer) {
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

export interface MockServerCtx {
  ca: { private: Uint8Array; public: Uint8Array }
  payload?: any
  clientStatic?: Buffer
  onClientFinish?: (send: (node: BinaryNode) => void) => void
  onNode?: (node: BinaryNode, send: (node: BinaryNode) => void) => void
}

/** Wire a mock WhatsApp server onto a WebSocketServer. */
export const runServer = (wss: any, ctx: MockServerCtx) => {
  const ca = ctx.ca
  wss.on('connection', (ws: any) => {
    const serverStatic = Curve.generateKeyPair()
    const serverEphemeral = Curve.generateKeyPair()
    const intermediate = Curve.generateKeyPair()
    const noise = new ServerNoise()
    let stage = 0

    const send = (node: BinaryNode) => ws.send(frame3(noise.encrypt(encodeBinaryNode(node))))

    ws.on('message', (raw: Buffer) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)

      if (stage === 0) {
        const hello = decodeHandshakeMessage(buf.subarray(7))
        const clientEphemeral = Buffer.from(hello.clientHello!.ephemeral)

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
        const clientStatic = Buffer.from(noise.decrypt(finish.clientFinish!.static))
        noise.mix(Curve.sharedKey(serverEphemeral.private, clientStatic))
        const payload = decodeClientPayload(noise.decrypt(finish.clientFinish!.payload))
        ctx.clientStatic = clientStatic
        ctx.payload = payload
        noise.finishInit()
        stage = 2
        ctx.onClientFinish?.(send)
        return
      }

      const size = buf.readUIntBE(0, 3)
      const nodeBuf = noise.decrypt(buf.subarray(3, size + 3))
      ctx.onNode?.(decodeBinaryNode(nodeBuf), send)
    })
  })
}

export const waitFor = (client: any, predicate: (update: any) => boolean, timeout = 6000) =>
  new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for event')), timeout)
    client.ev.on('connection.update', (update: any) => {
      if (predicate(update)) {
        clearTimeout(timer)
        resolve(update)
      }
    })
  })
