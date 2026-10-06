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
      if (node.tag === 'iq' && node.attrs.type === 'get' && node.attrs.xmlns === 'encrypt') {
        // No pre-keys on the server yet -> client must upload the initial batch.
        send({ tag: 'iq', attrs: { type: 'result', id: node.attrs.id }, content: [{ tag: 'count', attrs: { value: '0' } }] })
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
  let isOnline = false
  client.ev.on('connection.update', (u: any) => {
    if (u.receivedPendingNotifications) pendingNotifs = true
    if (u.isOnline) isOnline = true
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

  // Presence telemetry: Baileys sends <ib><unified_session id=..> on login.
  for (let i = 0; i < 100 && !received.some(n => n.tag === 'ib' && Array.isArray(n.content) && (n.content as BinaryNode[])[0]?.tag === 'unified_session'); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  const sessionIb = received.find(n => n.tag === 'ib' && Array.isArray(n.content) && (n.content as BinaryNode[])[0]?.tag === 'unified_session')
  const sessionChild = sessionIb ? (sessionIb.content as BinaryNode[])[0] : undefined
  check('unified_session sent on connect', !!sessionChild)
  check('unified_session id is a week-bucket', !!sessionChild && /^\d+$/.test(sessionChild.attrs.id ?? ''))

  // Server offers the offline queue; client must answer with an offline_batch.
  serverSend!({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_preview', attrs: {} }] })
  const isOfflineBatch = (n: BinaryNode) =>
    n.tag === 'ib' && Array.isArray(n.content) && (n.content as BinaryNode[]).some(c => c.tag === 'offline_batch')
  for (let i = 0; i < 100 && !received.some(isOfflineBatch); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  const batch = received.find(isOfflineBatch)
  check('offline_batch requested', !!batch)
  const batchChild = Array.isArray(batch?.content) ? (batch!.content as BinaryNode[])[0] : undefined
  check('offline_batch count=100', batchChild?.tag === 'offline_batch' && batchChild.attrs.count === '100')

  // The <offline> marker (sent in response above) flips receivedPendingNotifications.
  for (let i = 0; i < 100 && !pendingNotifs; i++) await new Promise(r => setTimeout(r, 10))
  check('receivedPendingNotifications emitted', pendingNotifs)

  // After login the client must top up the server's one-time pre-keys. Without
  // them no peer can open a Signal session to us, so the socket connects and
  // saves but never receives anything.
  for (let i = 0; i < 100 && !received.some(n => n.tag === 'iq' && n.attrs.type === 'set' && n.attrs.xmlns === 'encrypt'); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  const upload = received.find(n => n.tag === 'iq' && n.attrs.type === 'set' && n.attrs.xmlns === 'encrypt')
  check('pre-keys uploaded after success', !!upload)
  const uploadChildren = Array.isArray(upload?.content) ? (upload!.content as BinaryNode[]) : []
  check('upload carries registration', uploadChildren.some(c => c.tag === 'registration'))
  check('upload carries identity', uploadChildren.some(c => c.tag === 'identity'))
  check('upload carries signed pre-key', uploadChildren.some(c => c.tag === 'skey'))
  const keyList = uploadChildren.find(c => c.tag === 'list')
  const uploadedKeys = Array.isArray(keyList?.content) ? (keyList!.content as BinaryNode[]) : []
  check('initial batch is 812 one-time pre-keys', uploadedKeys.length === 812, `got=${uploadedKeys.length}`)

  // A low-supply notification must also trigger an upload and be acked.
  const beforeNotif = received.filter(n => n.tag === 'iq' && n.attrs.type === 'set' && n.attrs.xmlns === 'encrypt').length
  serverSend!({
    tag: 'notification',
    attrs: { from: '@s.whatsapp.net', id: 'PREKEY-LOW', type: 'encrypt' },
    content: [{ tag: 'count', attrs: { value: '0' } }]
  })
  for (let i = 0; i < 100 && received.filter(n => n.tag === 'iq' && n.attrs.type === 'set' && n.attrs.xmlns === 'encrypt').length === beforeNotif; i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  const notifUpload = received.filter(n => n.tag === 'iq' && n.attrs.type === 'set' && n.attrs.xmlns === 'encrypt')
  check('low pre-key notification triggers upload', notifUpload.length > beforeNotif)
  const notifAck = received.find(n => n.tag === 'ack' && n.attrs.id === 'PREKEY-LOW')
  check('pre-key notification acked', notifAck?.attrs.class === 'notification' && notifAck?.attrs.to === '@s.whatsapp.net')
  check('pre-key ack forwards type', notifAck?.attrs.type === 'encrypt', notifAck?.attrs.type)

  // Unknown notifications must still be acked (WA Web acks every notification),
  // otherwise they stay in the server's delivery queue.
  serverSend!({
    tag: 'notification',
    attrs: { from: 's.whatsapp.net', id: 'UNKNOWN-NOTIF', type: 'server_sync' },
    content: [{ tag: 'something', attrs: {} }]
  })
  for (let i = 0; i < 100 && !received.some(n => n.tag === 'ack' && n.attrs.id === 'UNKNOWN-NOTIF'); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  const unknownAck = received.find(n => n.tag === 'ack' && n.attrs.id === 'UNKNOWN-NOTIF')
  check('unknown notification acked', unknownAck?.attrs.class === 'notification', unknownAck?.attrs.class)
  check('unknown notification ack forwards type', unknownAck?.attrs.type === 'server_sync', unknownAck?.attrs.type)

  // markOnlineOnConnect (default true) must announce presence with our push
  // name, or the linked device shows as inactive on the phone.
  for (let i = 0; i < 100 && !received.some(n => n.tag === 'presence' && n.attrs.type === 'available'); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  const presence = received.find(n => n.tag === 'presence' && n.attrs.type === 'available')
  check('available presence sent on connect', !!presence)
  check('presence carries push name', presence?.attrs.name === 'tester', `got=${presence?.attrs.name}`)
  check('isOnline emitted', isOnline === true)

  // A QR-linked companion has no push name until app-state sync (which lightwa
  // does not implement). Presence must still go out so the linked device is not
  // stuck showing "last active" instead of online.
  client.authState.creds.me!.name = ''
  const beforeAnon = received.filter(n => n.tag === 'presence').length
  await client.sendPresenceUpdate('available')
  for (let i = 0; i < 100 && received.filter(n => n.tag === 'presence').length === beforeAnon; i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  const anonPresence = received.filter(n => n.tag === 'presence')[beforeAnon]
  check('nameless presence still sent', !!anonPresence)
  check('nameless presence omits name', anonPresence?.attrs.name === undefined, `got=${anonPresence?.attrs.name}`)
  check('nameless presence is available', anonPresence?.attrs.type === 'available')

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
