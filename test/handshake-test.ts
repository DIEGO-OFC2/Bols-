// End-to-end Noise handshake against a mock server that mirrors the WhatsApp
// server side of the protocol. Exercises the real socket client over a real
// websocket: client hello -> server hello + cert chain -> client finish ->
// transport, then a pair-device IQ to drive the QR flow.
import { WebSocketServer } from 'ws'
import { Curve } from '../src/crypto/index.js'
import { WAClient } from '../src/socket/client.js'
import { initAuthState } from '../src/utils/auth-utils.js'
import { runServer, waitFor } from './mock-server.js'

let pass = 0
let total = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const main = async () => {
  const ca = Curve.generateKeyPair()
  const ctx: any = { ca }
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>(res => wss.on('listening', () => res()))
  const port = (wss.address() as any).port

  ctx.onClientFinish = (send: (node: any) => void) => {
    check('server opens client finish', true)
    check('payload is registration', !!ctx.payload?.devicePairingData, JSON.stringify(Object.keys(ctx.payload ?? {})))
    check('eIdent is 32 bytes (raw identity key)', ctx.payload?.devicePairingData?.eIdent?.length === 32)
    send({
      tag: 'iq',
      attrs: { type: 'set', id: 'pair-1' },
      content: [{ tag: 'pair-device', attrs: {}, content: [{ tag: 'ref', attrs: {}, content: Buffer.from('REF-123') }] }]
    })
  }
  ctx.onNode = (node: any) => {
    check('server decrypts transport node', !!node?.tag)
  }
  runServer(wss, ctx)

  const auth = initAuthState()
  const client = new WAClient({
    waWebSocketUrl: `ws://127.0.0.1:${port}`,
    origin: 'https://web.whatsapp.com',
    auth,
    qrTimeout: 150,
    logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    noiseCertPublicKey: ca.public,
    noiseCertSerial: 0
  })

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
