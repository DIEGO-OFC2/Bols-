// Real-websocket test for the addressing transition a host hits in practice:
// a peer opens its Signal session while we are addressed by LID, sends a
// PN-addressed first message that carries `sender_lid`, then switches to
// LID-addressed follow-ups. lightwa must learn the LID mapping from the
// envelope, migrate the session, and decrypt both messages. Before the fix the
// follow-up found no session and was silently dropped — the "active but does
// not respond" symptom.
import { WebSocketServer } from 'ws'
import { Curve, generateSignalPubKey } from '../src/crypto/index.js'
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildBuffer, getBinaryNodeChildUInt } from '../src/wabinary/generic-utils.js'
import { WAClient } from '../src/socket/client.js'
import { SessionBuilder, SessionCipher, type PreKeyBundle } from '../src/signal/session.js'
import { encodeMessage } from '../src/proto/message.js'
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
const ME_LID = '100000000000000'
const ME_LID_JID = `${ME_LID}:0@lid`
const PEER = '15550000001'
const PEER_LID = '200000000000000'
const PEER_JID = `${PEER}@s.whatsapp.net`
const PEER_LID_JID = `${PEER_LID}:0@lid`

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
  let serverSend: ((node: BinaryNode) => void) | null = null
  let uploaded: BinaryNode | undefined

  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>(res => wss.on('listening', () => res()))
  const port = (wss.address() as any).port

  const auth = initAuthState()
  auth.creds.me = { id: ME_JID, name: 'tester' }

  runServer(wss, {
    ca,
    onClientFinish: send => {
      serverSend = send
      send({ tag: 'success', attrs: { lid: ME_LID_JID } })
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
    signedPreKey: {
      keyId: getBinaryNodeChildUInt(skey, 'id', 3)!,
      publicKey: generateSignalPubKey(getBinaryNodeChildBuffer(skey, 'value')!),
      signature: getBinaryNodeChildBuffer(skey, 'signature')!
    },
    preKey: { keyId: getBinaryNodeChildUInt(keyNode, 'id', 3)!, publicKey: generateSignalPubKey(getBinaryNodeChildBuffer(keyNode, 'value')!) }
  }

  // Peer opens its session while we are addressed by LID.
  const peerCipher = new SessionCipher(peerStorage as any, `${ME_LID}.0`)
  await new SessionBuilder(peerStorage as any, `${ME_LID}.0`).initOutgoing(bundle)

  // 1) PN-addressed first message carrying sender_lid — the envelope that
  //    teaches us the LID<->PN mapping.
  const first = await peerCipher.encrypt(Buffer.from(encodeMessage({ conversation: '.menu' }) as any))
  check('peer produced a pkmsg', first.type === 3)
  serverSend!({
    tag: 'message',
    attrs: {
      id: 'S1',
      from: PEER_JID,
      sender_lid: PEER_LID_JID,
      t: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      notify: 'owner'
    },
    content: [{ tag: 'enc', attrs: { v: '2', type: 'pkmsg' }, content: first.body }]
  })
  for (let i = 0; i < 200 && upserts.length < 1; i++) await new Promise(r => setTimeout(r, 10))
  check('PN-addressed first message surfaced', upserts.length >= 1, `got=${upserts.length}`)
  check('first text decoded', upserts[0]?.message?.conversation === '.menu', JSON.stringify(upserts[0]?.message))

  // 2) LID-addressed follow-up — must reach the migrated session.
  const second = await peerCipher.encrypt(Buffer.from(encodeMessage({ conversation: '.ping' }) as any))
  check('peer produced a follow-up msg', second.type === 3)
  serverSend!({
    tag: 'message',
    attrs: {
      id: 'S2',
      from: PEER_LID_JID,
      sender_pn: PEER_JID,
      addressing_mode: 'lid',
      t: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      notify: 'owner'
    },
    content: [{ tag: 'enc', attrs: { v: '2', type: 'pkmsg' }, content: second.body }]
  })
  for (let i = 0; i < 200 && upserts.length < 2; i++) await new Promise(r => setTimeout(r, 10))
  check('LID-addressed follow-up surfaced', upserts.length >= 2, `got=${upserts.length}`)
  check('follow-up text decoded', upserts[1]?.message?.conversation === '.ping', JSON.stringify(upserts[1]?.message))

  await client.close()
  wss.close()
  await new Promise(r => setTimeout(r, 100))
  console.log(`\n${pass}/${total} lid session transition checks passed`)
  process.exit(pass === total ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
