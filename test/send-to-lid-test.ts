// The bot replies to `m.chat`, which for a LID-addressed 1:1 chat is the
// `@lid` JID. The send path must resolve that to the wire LID form, fetch the
// bundle, open the session and emit the encrypted stanza. Guards the reply
// half of the addressing flow.
import { WebSocketServer } from 'ws'
import { Curve, generateSignalPubKey } from '../src/crypto/index.js'
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildBuffer, getBinaryNodeChildUInt } from '../src/wabinary/generic-utils.js'
import { WAClient } from '../src/socket/client.js'
import { encodeBinaryNode } from '../src/wabinary/encode.js'
import { decodeBinaryNode } from '../src/wabinary/decode.js'
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
const ME_LID_JID = '100000000000000@lid'
const PEER_LID = '200000000000000'
const PEER_LID_JID = `${PEER_LID}@lid`

const peerIdentity = Curve.generateKeyPair()
const peerSignedKp = Curve.generateKeyPair()
const peerPreKp = Curve.generateKeyPair()

const bundleNode = (jid: string): BinaryNode => ({
  tag: 'user',
  attrs: { jid },
  content: [
    { tag: 'registration', attrs: {}, content: Buffer.from([0, 0, 0x10, 0xe1]) },
    { tag: 'identity', attrs: {}, content: Buffer.from(generateSignalPubKey(peerIdentity.public)) },
    {
      tag: 'skey',
      attrs: {},
      content: [
        { tag: 'id', attrs: {}, content: Buffer.from([0, 0, 1]) },
        { tag: 'value', attrs: {}, content: Buffer.from(generateSignalPubKey(peerSignedKp.public)) },
        { tag: 'signature', attrs: {}, content: Buffer.from(Curve.sign(peerIdentity.private, generateSignalPubKey(peerSignedKp.public))) }
      ]
    },
    {
      tag: 'key',
      attrs: {},
      content: [
        { tag: 'id', attrs: {}, content: Buffer.from([0, 0, 5]) },
        { tag: 'value', attrs: {}, content: Buffer.from(generateSignalPubKey(peerPreKp.public)) }
      ]
    }
  ]
})

const main = async () => {
  const ca = Curve.generateKeyPair()
  let serverSend: ((node: BinaryNode) => void) | null = null
  const sentMessages: BinaryNode[] = []

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
        return void send({
          tag: 'iq',
          attrs: { type: 'result', id: node.attrs.id! },
          content: [
            {
              tag: 'usync',
              attrs: {},
              content: [
                {
                  tag: 'list',
                  attrs: {},
                  content: users.map(u => ({
                    tag: 'user',
                    attrs: { jid: u.attrs.jid! },
                    content: [
                      { tag: 'lid', attrs: { val: PEER_LID_JID } },
                      { tag: 'devices', attrs: {}, content: [{ tag: 'device-list', attrs: {}, content: [{ tag: 'device', attrs: { id: '0' } }] }] }
                    ]
                  }))
                }
              ]
            }
          ]
        })
      }
      if (node.tag === 'iq' && node.attrs.type === 'get' && node.attrs.xmlns === 'encrypt') {
        const users = getBinaryNodeChildren(getBinaryNodeChild(node, 'key'), 'user')
        return void send({
          tag: 'iq',
          attrs: { type: 'result', id: node.attrs.id },
          content: [{ tag: 'list', attrs: {}, content: users.map(u => bundleNode(u.attrs.jid!)) }]
        })
      }
      if (node.tag === 'iq' && node.attrs.type === 'set' && node.attrs.xmlns === 'encrypt') {
        return void send({ tag: 'iq', attrs: { type: 'result', id: node.attrs.id } })
      }
      if (node.tag === 'message') sentMessages.push(node)
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
  await new Promise(r => setTimeout(r, 100))

  const result = await client.sendMessage(PEER_LID_JID, { text: 'hola' })
  for (let i = 0; i < 200 && sentMessages.length < 1; i++) await new Promise(r => setTimeout(r, 10))

  check('sendMessage to LID resolved', result?.key?.remoteJid === PEER_LID_JID, String(result?.key?.remoteJid))
  check('encrypted message stanza emitted', sentMessages.length >= 1, `got=${sentMessages.length}`)
  const toNode = sentMessages[0] && getBinaryNodeChild(sentMessages[0], 'to')
  const enc = getBinaryNodeChild(toNode, 'enc')
  check('stanza carries an enc node', !!enc)
  check('enc is a pkmsg for a fresh LID session', enc?.attrs.type === 'pkmsg', String(enc?.attrs.type))
  check('session keyed under the LID form', await client.signalRepository.hasSession(PEER_LID_JID))

  await client.close()
  wss.close()
  await new Promise(r => setTimeout(r, 100))
  console.log(`\n${pass}/${total} send-to-lid checks passed`)
  process.exit(pass === total ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
