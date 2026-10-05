// Integration test for the full send pipeline over a real websocket: Noise
// handshake, login, device enumeration (USync), pre-key session establishment
// (assertSessions), and the encrypted <message> stanza. The mock server is the
// same one the handshake test uses.
import { WebSocketServer } from 'ws'
import { Curve, generateSignalPubKey, signedKeyPair } from '../src/crypto/index.js'
import { decodeBinaryNode } from '../src/wabinary/decode.js'
import { encodeBinaryNode } from '../src/wabinary/encode.js'
import { getBinaryNodeChild, getBinaryNodeChildren } from '../src/wabinary/generic-utils.js'
import { WAClient } from '../src/socket/client.js'
import { SessionCipher, type PreKeyBundle } from '../src/signal/session.js'
import { encodeBigEndian } from '../src/utils/generics.js'
import { initAuthState } from '../src/utils/auth-utils.js'
import type { BinaryNode } from '../src/wabinary/types.js'
import { runServer, waitFor, type MockServerCtx } from './mock-server.js'

let pass = 0
let total = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const PEER = '15550000001'
const PEER_JID = `${PEER}@s.whatsapp.net`

// Peer (bob) Signal material the mock server hands out as a pre-key bundle.
const bobIdentity = Curve.generateKeyPair()
const bobSignedKp = signedKeyPair(bobIdentity, 1)
const bobPreKey = Curve.generateKeyPair()
const bobBundle: PreKeyBundle = {
  registrationId: 4321,
  identityKey: generateSignalPubKey(bobIdentity.public),
  signedPreKey: { keyId: 1, publicKey: generateSignalPubKey(bobSignedKp.keyPair.public), signature: bobSignedKp.signature },
  preKey: { keyId: 9, publicKey: generateSignalPubKey(bobPreKey.public) }
}

// Peer-side storage so the test can decrypt what the client sent.
const bobSessions = new Map<string, any>()
const bobPreKeys = new Map<number, any>([[9, { privKey: Buffer.from(bobPreKey.private), pubKey: generateSignalPubKey(bobPreKey.public) }]])
const bobSigned = { privKey: Buffer.from(bobSignedKp.keyPair.private), pubKey: generateSignalPubKey(bobSignedKp.keyPair.public) }
const bobIdentitySignal = { privKey: Buffer.from(bobIdentity.private), pubKey: generateSignalPubKey(bobIdentity.public) }
const bobStorage = {
  loadSession: async (id: string) => bobSessions.get(id) ?? null,
  storeSession: async (id: string, rec: any) => void bobSessions.set(id, rec),
  isTrustedIdentity: async () => true,
  loadPreKey: async (id: number) => bobPreKeys.get(id),
  removePreKey: async (id: number) => void bobPreKeys.delete(id),
  loadSignedPreKey: async () => bobSigned,
  getOurRegistrationId: () => 4321,
  getOurIdentity: () => bobIdentitySignal
}

const usyncResult = (id: string, jids: string[], device: number): BinaryNode => ({
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
            content: [
              { tag: 'devices', attrs: {}, content: [{ tag: 'device-list', attrs: {}, content: [{ tag: 'device', attrs: { id: String(device) } }] }] }
            ]
          }))
        }
      ]
    }
  ]
})

const main = async () => {
  const ca = Curve.generateKeyPair()
  const ctx: MockServerCtx = { ca }
  const sent: BinaryNode[] = []
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>(res => wss.on('listening', () => res()))
  const port = (wss.address() as any).port

  runServer(wss, {
    ca,
    onClientFinish: send => send({ tag: 'success', attrs: { lid: '100000000000000' } }),
    onNode: (node, send) => {
      if (node.tag === 'iq' && node.attrs.type === 'get' && node.attrs.xmlns === 'usync') {
        const users = getBinaryNodeChildren(getBinaryNodeChild(getBinaryNodeChild(node, 'usync'), 'list'), 'user')
        const jids = users.map(u => u.attrs.jid!)
        return void send(usyncResult(node.attrs.id!, jids, 0))
      }
      if (node.tag === 'iq' && node.attrs.type === 'get' && node.attrs.xmlns === 'encrypt') {
        const users = getBinaryNodeChildren(getBinaryNodeChild(node, 'key'), 'user')
        return void send({
          tag: 'iq',
          attrs: { type: 'result', id: node.attrs.id },
          content: [
            {
              tag: 'list',
              attrs: {},
              content: users.map(u => ({
                tag: 'user',
                attrs: { jid: u.attrs.jid },
                content: [
                  { tag: 'registration', attrs: {}, content: encodeBigEndian(bobBundle.registrationId, 4) },
                  { tag: 'identity', attrs: {}, content: bobBundle.identityKey },
                  { tag: 'skey', attrs: {}, content: [
                    { tag: 'id', attrs: {}, content: encodeBigEndian(1, 3) },
                    { tag: 'value', attrs: {}, content: bobSignedKp.keyPair.public },
                    { tag: 'signature', attrs: {}, content: bobSignedKp.signature }
                  ] },
                  { tag: 'key', attrs: {}, content: [
                    { tag: 'id', attrs: {}, content: encodeBigEndian(9, 3) },
                    { tag: 'value', attrs: {}, content: bobPreKey.public }
                  ] }
                ]
              }))
            }
          ]
        })
      }
      if (node.tag === 'message') sent.push(node)
    }
  })

  const auth = initAuthState()
  auth.creds.me = { id: '15559999999:0@s.whatsapp.net', name: 'tester' }
  const client = new WAClient({
    waWebSocketUrl: `ws://127.0.0.1:${port}`,
    origin: 'https://web.whatsapp.com',
    auth,
    logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    noiseCertPublicKey: ca.public,
    noiseCertSerial: 0
  })

  const open = waitFor(client, u => u.connection === 'open')
  client.connect()
  await open
  check('client reached open', true)

  const result = await client.sendMessage(PEER_JID, { text: 'hola mundo' })
  check('sendMessage returned a key', !!result.key.id)

  // The server processes frames asynchronously; wait for the stanza to land.
  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise(r => setTimeout(r, 20))
  check('message stanza delivered', sent.length === 1, `sent=${sent.length}`)

  const stanza = sent[0]!
  check('stanza addressed to peer', stanza.attrs.to === PEER_JID)
  const toNodes = getBinaryNodeChildren(stanza, 'to')
  check('one encrypted <to> node', toNodes.length === 1, `to=${toNodes.length}`)
  const enc = getBinaryNodeChild(toNodes[0], 'enc')
  check('enc is a pkmsg (new session)', enc?.attrs.type === 'pkmsg', `type=${enc?.attrs.type}`)
  check('enc has ciphertext', (enc?.content as Uint8Array)?.length > 0)

  // The peer decrypts the prekey message and reads the plaintext.
  const cipher = new SessionCipher(bobStorage as any, `15559999999.0`)
  const plaintext = await cipher.decryptPreKeyWhisperMessage(Buffer.from(enc!.content as Uint8Array))
  check('peer decrypts the ciphertext', plaintext.length > 0)
  check('plaintext is the conversation message', plaintext.toString('latin1').includes('hola mundo'), plaintext.toString('latin1'))

  await client.close()
  wss.close()
  await new Promise(r => setTimeout(r, 100))

  console.log(`\n${pass}/${total} send pipeline checks passed`)
  if (pass !== total) process.exitCode = 1
  process.exit(pass === total ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
