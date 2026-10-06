// End-to-end command round-trip over a real websocket, mirroring what a host
// like the V3 bot does: the server delivers a peer's encrypted command, the
// client must surface it via `messages.upsert`, and a reply sent from the
// handler must reach the peer as a decryptable <message> stanza.
import { WebSocketServer } from 'ws'
import { Curve, generateSignalPubKey } from '../src/crypto/index.js'
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildBuffer, getBinaryNodeChildUInt } from '../src/wabinary/generic-utils.js'
import { WAClient } from '../src/socket/client.js'
import { SessionBuilder, SessionCipher, type PreKeyBundle } from '../src/signal/session.js'
import { encodeMessage, decodeMessage } from '../src/proto/message.js'
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

const PEER = '15550000001'
const PEER_JID = `${PEER}@s.whatsapp.net`

// Peer-side Signal storage: owns the outgoing session the peer uses to reach us.
const peerIdentity = Curve.generateKeyPair()
const peerSignedKp = Curve.generateKeyPair()
const peerSigned = {
  privKey: Buffer.from(peerSignedKp.private),
  pubKey: generateSignalPubKey(peerSignedKp.public)
}
const peerSessions = new Map<string, any>()
const peerStorage = {
  loadSession: async (id: string) => peerSessions.get(id) ?? null,
  storeSession: async (id: string, rec: any) => void peerSessions.set(id, rec),
  isTrustedIdentity: async () => true,
  loadPreKey: async () => undefined,
  removePreKey: async () => {},
  loadSignedPreKey: async () => peerSigned,
  getOurRegistrationId: () => 4321,
  getOurIdentity: () => ({ privKey: Buffer.from(peerIdentity.private), pubKey: generateSignalPubKey(peerIdentity.public) })
}

const usyncResult = (id: string, jids: string[]): BinaryNode => ({
  tag: 'iq',
  attrs: { type: 'result', id },
  content: [
    {
      tag: 'usync',
      attrs: {},
      content: [
        {
          tag: 'list',
          attrs: {},
          content: jids.map(jid => ({
            tag: 'user',
            attrs: { jid },
            content: [{ tag: 'devices', attrs: {}, content: [{ tag: 'device-list', attrs: {}, content: [{ tag: 'device', attrs: { id: '0' } }] }] }]
          }))
        }
      ]
    }
  ]
})

const main = async () => {
  const ca = Curve.generateKeyPair()
  const sent: BinaryNode[] = []
  const acks: BinaryNode[] = []
  let serverSend: ((node: BinaryNode) => void) | null = null
  let uploaded: BinaryNode | undefined

  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>(res => wss.on('listening', () => res()))
  const port = (wss.address() as any).port

  const auth = initAuthState()
  auth.creds.me = { id: '15559999999:0@s.whatsapp.net', name: 'tester' }

  runServer(wss, {
    ca,
    onClientFinish: send => {
      serverSend = send
      send({ tag: 'success', attrs: { lid: '100000000000000@lid' } })
    },
    onNode: (node, send) => {
      if (node.tag === 'iq' && node.attrs.type === 'get' && node.attrs.xmlns === 'usync') {
        const users = getBinaryNodeChildren(getBinaryNodeChild(getBinaryNodeChild(node, 'usync'), 'list'), 'user')
        return void send(usyncResult(node.attrs.id!, users.map(u => u.attrs.jid!)))
      }
      if (node.tag === 'iq' && node.attrs.type === 'get' && node.attrs.xmlns === 'encrypt') {
        return void send({ tag: 'iq', attrs: { type: 'result', id: node.attrs.id }, content: [{ tag: 'list', attrs: {} }] })
      }
      if (node.tag === 'iq' && node.attrs.type === 'set' && node.attrs.xmlns === 'encrypt') {
        uploaded = node
        return void send({ tag: 'iq', attrs: { type: 'result', id: node.attrs.id } })
      }
      if (node.tag === 'ack') acks.push(node)
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
  check('client reached open', true)

  const upserts: any[] = []
  client.ev.on('messages.upsert', (e: any) => upserts.push(...e.messages))

  for (let i = 0; i < 200 && !uploaded; i++) await new Promise(r => setTimeout(r, 10))
  check('client uploaded pre-keys', !!uploaded)

  const identity = getBinaryNodeChildBuffer(uploaded!, 'identity')!
  const skey = getBinaryNodeChild(uploaded!, 'skey')!
  const skeyId = getBinaryNodeChildUInt(skey, 'id', 3)!
  const skeyValue = getBinaryNodeChildBuffer(skey, 'value')!
  const skeySig = getBinaryNodeChildBuffer(skey, 'signature')!
  const keyNode = getBinaryNodeChildren(getBinaryNodeChild(uploaded!, 'list'), 'key')[0]!
  const keyId = getBinaryNodeChildUInt(keyNode, 'id', 3)!
  const keyValue = getBinaryNodeChildBuffer(keyNode, 'value')!

  const bundle: PreKeyBundle = {
    registrationId: getBinaryNodeChildUInt(uploaded!, 'registration', 4)!,
    identityKey: generateSignalPubKey(identity),
    signedPreKey: { keyId: skeyId, publicKey: generateSignalPubKey(skeyValue), signature: skeySig },
    preKey: { keyId, publicKey: generateSignalPubKey(keyValue) }
  }

  const peerCipher = new SessionCipher(peerStorage as any, '15559999999.0')
  const builder = new SessionBuilder(peerStorage as any, '15559999999.0')
  await builder.initOutgoing(bundle)
  const enc = await peerCipher.encrypt(Buffer.from(encodeMessage({ conversation: '.menu' }) as any))
  check('peer produced a pkmsg', enc.type === 3)

  serverSend!({
    tag: 'message',
    attrs: { id: 'CMD1', from: PEER_JID, t: String(Math.floor(Date.now() / 1000)), type: 'text', notify: 'owner' },
    content: [{ tag: 'enc', attrs: { v: '2', type: 'pkmsg' }, content: enc.body }]
  })

  for (let i = 0; i < 200 && upserts.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  check('command surfaced via messages.upsert', upserts.length === 1, `got=${upserts.length}`)
  const msg = upserts[0]
  check('command text decoded', msg?.message?.conversation === '.menu', JSON.stringify(msg?.message))
  check('command key.remoteJid is the peer', msg?.key?.remoteJid === PEER_JID)
  check('command key.fromMe is false', msg?.key?.fromMe === false)
  for (let i = 0; i < 100 && !acks.some(a => a.attrs.id === 'CMD1'); i++) await new Promise(r => setTimeout(r, 10))
  check('command stanza acked', acks.some(a => a.attrs.id === 'CMD1'))

  await client.sendMessage(PEER_JID, { text: 'pong' })
  for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  check('reply stanza delivered', sent.length === 1, `sent=${sent.length}`)
  const reply = sent[0]!
  const toNodes = getBinaryNodeChildren(reply, 'to')
  check('reply has exactly one <to>', toNodes.length === 1, `to=${toNodes.length}`)
  const replyEnc = getBinaryNodeChild(toNodes[0], 'enc')!
  const decrypted = await peerCipher.decryptWhisperMessage(Buffer.from(replyEnc.content as Uint8Array))
  const replyBody = decodeMessage(decrypted)
  check('peer decrypts the reply', replyBody.extendedTextMessage?.text === 'pong', JSON.stringify(replyBody))

  await client.close()
  wss.close()
  await new Promise(r => setTimeout(r, 100))

  console.log(`\n${pass}/${total} command roundtrip checks passed`)
  if (pass !== total) process.exitCode = 1
  process.exit(pass === total ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
