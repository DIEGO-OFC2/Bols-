// WhatsApp clients pad the outer protobuf with 1..16 random bytes before
// Signal-encrypting it (PKCS#7-style) and strip that padding after decrypting.
// lightwa did neither, so a real peer's padded message was fed straight into
// the protobuf decoder and threw (`unsupported proto wire type 6`), which the
// host saw as "session active but the bot never answers". This suite covers the
// pad/unpad primitives, an inbound padded message for every pad length, and the
// outbound stanza being padded the way a real client expects.
import { WebSocketServer } from 'ws'
import { Curve, generateSignalPubKey } from '../src/crypto/index.js'
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildBuffer, getBinaryNodeChildUInt } from '../src/wabinary/generic-utils.js'
import { WAClient } from '../src/socket/client.js'
import { SessionBuilder, SessionCipher, type PreKeyBundle } from '../src/signal/session.js'
import { encodeMessage, decodeMessage } from '../src/proto/message.js'
import { writeRandomPadMax16, unpadRandomMax16 } from '../src/utils/generics.js'
import { initAuthState } from '../src/utils/auth-utils.js'
import type { BinaryNode } from '../src/wabinary/types.js'
import { runServer, waitFor } from './mock-server.js'

let pass = 0
let total = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const ME = '15559999999'
const ME_JID = `${ME}:0@s.whatsapp.net`
const PEER = '15550000001'
const PEER_JID = `${PEER}@s.whatsapp.net`

const peerIdentity = Curve.generateKeyPair()
const peerSignedKp = Curve.generateKeyPair()
const peerSessions = new Map<string, any>()
const peerStorage = {
  loadSession: async (id: string) => peerSessions.get(id) ?? null,
  storeSession: async (id: string, rec: any) => void peerSessions.set(id, rec),
  isTrustedIdentity: async () => true,
  loadPreKey: async () => undefined,
  removePreKey: async () => {},
  loadSignedPreKey: async () => ({ privKey: Buffer.from(peerSignedKp.private), pubKey: generateSignalPubKey(peerSignedKp.public) }),
  getOurRegistrationId: () => 4321,
  getOurIdentity: () => ({ privKey: Buffer.from(peerIdentity.private), pubKey: generateSignalPubKey(peerIdentity.public) })
}

// Deterministic pad writer: `padLength` bytes each equal to `padLength`.
const padWith = (msg: Uint8Array, padLength: number): Buffer =>
  Buffer.concat([msg, Buffer.alloc(padLength, padLength)])

const main = async () => {
  // ── primitives ───────────────────────────────────────────────────────────
  for (let len = 1; len <= 16; len++) {
    const padded = padWith(Buffer.from('hola mundo'), len)
    check(`unpad length ${len}`, unpadRandomMax16(padded).toString() === 'hola mundo')
  }
  const randomPad = writeRandomPadMax16(Buffer.from('abc'))
  const padLen = randomPad[randomPad.length - 1]!
  check('writeRandomPadMax16 length in 1..16', padLen >= 1 && padLen <= 16, `pad=${padLen}`)
  check('writeRandomPadMax16 round-trips', unpadRandomMax16(randomPad).toString() === 'abc')
  let threwEmpty = false
  try { unpadRandomMax16(Buffer.alloc(0)) } catch { threwEmpty = true }
  check('unpad rejects empty input', threwEmpty)
  let threwOversized = false
  try { unpadRandomMax16(Buffer.from([1, 2, 9])) } catch { threwOversized = true }
  check('unpad rejects pad larger than buffer', threwOversized)

  // ── end-to-end ───────────────────────────────────────────────────────────
  const ca = Curve.generateKeyPair()
  let serverSend: ((node: BinaryNode) => void) | null = null
  let uploaded: BinaryNode | undefined
  const sent: BinaryNode[] = []

  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>(res => wss.on('listening', () => res()))
  const port = (wss.address() as any).port

  const auth = initAuthState()
  auth.creds.me = { id: ME_JID, name: 'tester' }

  runServer(wss, {
    ca,
    onClientFinish: send => { serverSend = send; send({ tag: 'success', attrs: { lid: '100000000000000:0@lid' } }) },
    onNode: (node, send) => {
      if (node.tag === 'iq' && node.attrs.type === 'get' && node.attrs.xmlns === 'usync') {
        const users = getBinaryNodeChildren(getBinaryNodeChild(getBinaryNodeChild(node, 'usync'), 'list'), 'user')
        return void send({
          tag: 'iq',
          attrs: { type: 'result', id: node.attrs.id },
          content: [{ tag: 'usync', attrs: {}, content: [{ tag: 'list', attrs: {}, content: users.map(u => ({
            tag: 'user', attrs: { jid: u.attrs.jid! },
            content: [{ tag: 'devices', attrs: {}, content: [{ tag: 'device-list', attrs: {}, content: [{ tag: 'device', attrs: { id: '0' } }] }] }]
          })) }] }]
        })
      }
      if (node.tag === 'iq' && node.attrs.type === 'get' && node.attrs.xmlns === 'encrypt') {
        return void send({ tag: 'iq', attrs: { type: 'result', id: node.attrs.id }, content: [{ tag: 'list', attrs: {} }] })
      }
      if (node.tag === 'iq' && node.attrs.type === 'set' && node.attrs.xmlns === 'encrypt') {
        uploaded = node
        return void send({ tag: 'iq', attrs: { type: 'result', id: node.attrs.id } })
      }
      if (node.tag === 'message') sent.push(node)
    }
  })

  const client = new WAClient({
    waWebSocketUrl: `ws://127.0.0.1:${port}`,
    origin: 'https://web.whatsapp.com',
    auth,
    logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    noiseCertPublicKey: ca.public,
    noiseCertSerial: 0
  })
  const open = waitFor(client, u => u.connection === 'open')
  client.connect()
  await open
  const upserts: any[] = []
  client.ev.on('messages.upsert', (e: any) => upserts.push(...e.messages))

  for (let i = 0; i < 200 && !uploaded; i++) await new Promise(r => setTimeout(r, 10))
  check('client uploaded pre-keys', !!uploaded)

  const identity = getBinaryNodeChildBuffer(uploaded!, 'identity')!
  const skey = getBinaryNodeChild(uploaded!, 'skey')!
  const keyNode = getBinaryNodeChildren(getBinaryNodeChild(uploaded!, 'list'), 'key')[0]!
  const bundle: PreKeyBundle = {
    registrationId: getBinaryNodeChildUInt(uploaded!, 'registration', 4)!,
    identityKey: generateSignalPubKey(identity),
    signedPreKey: { keyId: getBinaryNodeChildUInt(skey, 'id', 3)!, publicKey: generateSignalPubKey(getBinaryNodeChildBuffer(skey, 'value')!), signature: getBinaryNodeChildBuffer(skey, 'signature')! },
    preKey: { keyId: getBinaryNodeChildUInt(keyNode, 'id', 3)!, publicKey: generateSignalPubKey(getBinaryNodeChildBuffer(keyNode, 'value')!) }
  }

  const peerCipher = new SessionCipher(peerStorage as any, `${ME}.0`)
  await new SessionBuilder(peerStorage as any, `${ME}.0`).initOutgoing(bundle)

  // Every pad length must survive decrypt → unpad → decode.
  for (let len = 1; len <= 16; len++) {
    const body = padWith(encodeMessage({ conversation: `.p${len}` }) as any, len)
    const enc = await peerCipher.encrypt(body)
    serverSend!({
      tag: 'message',
      attrs: { id: `PAD${len}`, from: PEER_JID, t: String(Math.floor(Date.now() / 1000)), type: 'text', notify: 'owner' },
      content: [{ tag: 'enc', attrs: { v: '2', type: enc.type === 3 ? 'pkmsg' : 'msg' }, content: enc.body }]
    })
    for (let i = 0; i < 200 && upserts.length < len; i++) await new Promise(r => setTimeout(r, 10))
    check(`padded inbound (len ${len}) surfaced`, upserts.length >= len, `got=${upserts.length}`)
    check(`padded inbound (len ${len}) decoded`, upserts[len - 1]?.message?.conversation === `.p${len}`, JSON.stringify(upserts[len - 1]?.message))
  }

  // Outbound: the stanza a peer receives must be padded, not raw protobuf.
  await client.sendMessage(PEER_JID, { text: 'pong' })
  for (let i = 0; i < 200 && sent.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  check('reply stanza delivered', sent.length >= 1, `sent=${sent.length}`)
  const toNode = getBinaryNodeChildren(sent[0]!, 'to')[0]!
  const replyEnc = getBinaryNodeChild(toNode, 'enc')!
  const decrypted = await peerCipher.decryptWhisperMessage(Buffer.from(replyEnc.content as Uint8Array))
  const lastByte = decrypted[decrypted.length - 1]!
  check('outbound payload is padded', lastByte >= 1 && lastByte <= 16, `last=${lastByte}`)
  const replyBody = decodeMessage(unpadRandomMax16(decrypted))
  check('outbound decodes after unpad', replyBody.extendedTextMessage?.text === 'pong', JSON.stringify(replyBody))

  await client.close()
  wss.close()
  await new Promise(r => setTimeout(r, 100))
  console.log(`\n${pass}/${total} message padding checks passed`)
  if (pass !== total) process.exitCode = 1
  process.exit(pass === total ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
