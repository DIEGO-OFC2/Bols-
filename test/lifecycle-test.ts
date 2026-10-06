/**
 * Post-login connection lifecycle against the mock server. Guards the pieces
 * that keep the socket *receiving* after the initial burst: the passive→active
 * switch, the offline_preview/offline_batch handshake, and the
 * receivedPendingNotifications signal.
 */
import { WebSocketServer } from 'ws'
import { Curve } from '../src/crypto/index.js'
import { WAClient } from '../src/socket/client.js'
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

const main = async () => {
  const ca = Curve.generateKeyPair()
  const received: BinaryNode[] = []
  let serverSend: ((node: BinaryNode) => void) | null = null

  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>(res => wss.on('listening', () => res()))
  const port = (wss.address() as any).port

  runServer(wss, {
    ca,
    onClientFinish: send => {
      serverSend = send
      send({ tag: 'success', attrs: { lid: '100000000000000' } })
    },
    onNode: (node, send) => {
      received.push(node)
      if (node.tag === 'iq' && node.attrs.xmlns === 'passive') {
        send({ tag: 'iq', attrs: { type: 'result', id: node.attrs.id } })
      }
      if (node.tag === 'ib') {
        const child = Array.isArray(node.content) ? (node.content[0] as BinaryNode) : undefined
        if (child?.tag === 'offline_batch') {
          send({ tag: 'ib', attrs: {}, content: [{ tag: 'offline', attrs: { count: '0' } }] })
        }
      }
    }
  })

  const auth = initAuthState()
  auth.creds.me = { id: '15559999999:0@s.whatsapp.net', name: 'tester' }
  const client = new WAClient({
    waWebSocketUrl: `ws://127.0.0.1:${port}`,
    origin: 'https://web.whatsapp.com',
    auth,
    logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    noiseCertPublicKey: ca.public,
    noiseCertSerial: 0
  })

  let pendingNotifs = false
  client.ev.on('connection.update', (u: any) => {
    if (u.receivedPendingNotifications) pendingNotifs = true
  })

  const open = waitFor(client, u => u.connection === 'open')
  client.connect()
  await open
  check('client reached open', true)

  // The passive→active IQ must be sent once `success` lands.
  for (let i = 0; i < 100 && !received.some(n => n.tag === 'iq' && n.attrs.xmlns === 'passive'); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  const activeIq = received.find(n => n.tag === 'iq' && n.attrs.xmlns === 'passive')
  check('passive iq sent after success', !!activeIq)
  check('passive iq is type=set', activeIq?.attrs.type === 'set')
  const activeChild = Array.isArray(activeIq?.content) ? (activeIq!.content as BinaryNode[])[0] : undefined
  check('passive iq carries <active/>', activeChild?.tag === 'active')

  // Server offers the offline queue; client must answer with an offline_batch.
  serverSend!({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_preview', attrs: {} }] })
  for (let i = 0; i < 100 && !received.some(n => n.tag === 'ib'); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  const batch = received.find(n => n.tag === 'ib')
  check('offline_batch requested', !!batch)
  const batchChild = Array.isArray(batch?.content) ? (batch!.content as BinaryNode[])[0] : undefined
  check('offline_batch count=100', batchChild?.tag === 'offline_batch' && batchChild.attrs.count === '100')

  // The <offline> marker (sent in response above) flips receivedPendingNotifications.
  for (let i = 0; i < 100 && !pendingNotifs; i++) await new Promise(r => setTimeout(r, 10))
  check('receivedPendingNotifications emitted', pendingNotifs)

  await client.close()
  wss.close()
  await new Promise(r => setTimeout(r, 100))

  console.log(`\n${pass}/${total} connection lifecycle checks passed`)
  process.exit(pass === total ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
