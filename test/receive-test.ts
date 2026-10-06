/**
 * Receiving-pipeline test: drives `handleIncomingMessage` with real Signal
 * ciphertext and asserts the emitted `messages.upsert` key. Covers the
 * `fromMe`/`remoteJid` derivation Baileys does in `decodeMessageNode`, which
 * private-mode hosts (the V3 bot) filter on.
 */
import { Curve, generateSignalPubKey } from '../src/crypto/index.js'
import { WAClient } from '../src/socket/client.js'
import { SignalRepository } from '../src/signal/repository.js'
import { encodeMessage } from '../src/proto/message.js'
import { writeRandomPadMax16 } from '../src/utils/generics.js'
import { decodeBinaryNode } from '../src/wabinary/decode.js'
import { encodeBinaryNode } from '../src/wabinary/encode.js'
import { initAuthState, type AuthenticationState } from '../src/utils/auth-utils.js'
import type { KeyPair } from '../src/crypto/index.js'
import type { IncomingMessage } from '../src/socket/client.js'

let total = 0
let pass = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const ME = '15559999999'
const ME_JID = `${ME}@s.whatsapp.net`
const ME_DEVICE_JID = `${ME}:5@s.whatsapp.net`
const ME_LID = '999999999999999@lid'
const BOB = '15550000001'
const BOB_JID = `${BOB}@s.whatsapp.net`
const GROUP = '120363000000000000@g.us'

const repoFor = (state: AuthenticationState) =>
  new SignalRepository(state, { debug: () => {}, warn: () => {} })

// Build a pre-key bundle from a state's own creds so a peer can open a session
// to it. The matching private pre-key is stored under `id`.
const bundleFor = async (state: AuthenticationState, id: number) => {
  const preKey: KeyPair = Curve.generateKeyPair()
  await state.keys.set({ 'pre-key': { [id]: preKey as any } })
  return {
    registrationId: state.creds.registrationId,
    identityKey: generateSignalPubKey(state.creds.signedIdentityKey.public),
    signedPreKey: {
      keyId: state.creds.signedPreKey.keyId,
      publicKey: generateSignalPubKey(state.creds.signedPreKey.keyPair.public),
      signature: state.creds.signedPreKey.signature
    },
    preKey: { keyId: id, publicKey: generateSignalPubKey(preKey.public) }
  }
}

const run = async () => {
  const meState = initAuthState()
  meState.creds.me = { id: `${ME}:0@s.whatsapp.net`, name: 'me', lid: ME_LID }
  const meRepo = repoFor(meState)

  // Capture the acks the client sends (normally over the noise transport).
  const acks: any[] = []
  const client = new WAClient({ auth: meState, logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any })
  ;(client as any).noise = { encodeFrame: (b: Buffer) => b }
  ;(client as any)._ws = { readyState: 1, send: (d: Buffer, cb?: () => void) => { acks.push(decodeBinaryNode(d)); cb?.() } }

  const upserts: IncomingMessage[] = []
  client.ev.on('messages.upsert', ({ messages }) => upserts.push(messages[0]!))

  const feed = async (stanza: any) => {
    const before = upserts.length
    await (client as any).handleIncomingMessage(stanza)
    for (let i = 0; i < 100 && upserts.length === before; i++) await new Promise(r => setTimeout(r, 5))
    return upserts.length > before ? upserts[upserts.length - 1] : undefined
  }

  // ── 1:1 message from a peer (fromMe=false, remoteJid=peer) ───────────────
  const bobState = initAuthState()
  bobState.creds.me = { id: `${BOB}:0@s.whatsapp.net` }
  const bobRepo = repoFor(bobState)
  await bobRepo.injectE2ESession(ME_JID, await bundleFor(meState, 1))
  const peerEnc = await bobRepo.encryptMessage(ME_JID, writeRandomPadMax16(encodeMessage({ conversation: 'hola' })))
  const peerMsg = await feed({
    tag: 'message',
    attrs: { from: BOB_JID, id: 'MSG-PEER', t: '1700000000', notify: 'Bob' },
    content: [{ tag: 'enc', attrs: { type: peerEnc.type, v: '2' }, content: peerEnc.ciphertext }]
  })
  check('peer message emitted', !!peerMsg)
  check('peer fromMe=false', peerMsg?.key.fromMe === false)
  check('peer remoteJid=peer', peerMsg?.key.remoteJid === BOB_JID, peerMsg?.key.remoteJid)
  check('peer pushName kept', peerMsg?.pushName === 'Bob', String(peerMsg?.pushName))
  check('peer text decoded', peerMsg?.message.conversation === 'hola', JSON.stringify(peerMsg?.message))

  // ── self echo from our primary device, routed via `recipient` ────────────
  // Same account, different device: `areJidsSameUser` ignores the device, so
  // this must be flagged fromMe with the chat taken from `recipient`.
  const primaryState = initAuthState()
  primaryState.creds.me = { id: ME_DEVICE_JID }
  const primaryRepo = repoFor(primaryState)
  await primaryRepo.injectE2ESession(ME_JID, await bundleFor(meState, 2))
  const selfEnc = await primaryRepo.encryptMessage(ME_JID, writeRandomPadMax16(encodeMessage({ conversation: '.menu' })))
  const selfMsg = await feed({
    tag: 'message',
    attrs: { from: ME_DEVICE_JID, recipient: BOB_JID, id: 'MSG-SELF', t: '1700000001' },
    content: [{ tag: 'enc', attrs: { type: selfEnc.type, v: '2' }, content: selfEnc.ciphertext }]
  })
  check('self echo emitted', !!selfMsg)
  check('self echo fromMe=true', selfMsg?.key.fromMe === true)
  check('self echo remoteJid=recipient', selfMsg?.key.remoteJid === BOB_JID, selfMsg?.key.remoteJid)

  // ── group echo carrying our own participant (fromMe=true) ────────────────
  // Sent by our primary device, decrypted here: same account, different device.
  const primaryDist = await primaryRepo.createSenderKeyDistribution(GROUP, ME, 5)
  await meRepo.processSenderKeyDistribution(GROUP, ME_DEVICE_JID, primaryDist)
  const groupEnc = await primaryRepo.encryptGroupMessage(GROUP, ME, 5, writeRandomPadMax16(encodeMessage({ conversation: '#ping' })))
  const groupMsg = await feed({
    tag: 'message',
    attrs: { from: GROUP, participant: ME_DEVICE_JID, id: 'MSG-GROUP', t: '1700000002' },
    content: [{ tag: 'enc', attrs: { type: 'skmsg', v: '2' }, content: groupEnc }]
  })
  check('group self echo emitted', !!groupMsg)
  check('group self echo fromMe=true', groupMsg?.key.fromMe === true)
  check('group remoteJid=group', groupMsg?.key.remoteJid === GROUP, groupMsg?.key.remoteJid)
  check('group participant kept', groupMsg?.key.participant === ME_DEVICE_JID)

  // ── group message from a peer (fromMe=false) ─────────────────────────────
  const bobDist = await bobRepo.createSenderKeyDistribution(GROUP, BOB, 0)
  await meRepo.processSenderKeyDistribution(GROUP, BOB_JID, bobDist)
  const bobGroupEnc = await bobRepo.encryptGroupMessage(GROUP, BOB, 0, writeRandomPadMax16(encodeMessage({ conversation: '.help' })))
  const bobGroupMsg = await feed({
    tag: 'message',
    attrs: { from: GROUP, participant: BOB_JID, id: 'MSG-GROUP-BOB', t: '1700000003' },
    content: [{ tag: 'enc', attrs: { type: 'skmsg', v: '2' }, content: bobGroupEnc }]
  })
  check('group peer emitted', !!bobGroupMsg)
  check('group peer fromMe=false', bobGroupMsg?.key.fromMe === false)

  // ── sender-key distribution delivered over the wire ──────────────────────
  // lightwa sends the SKDM as its own padded Signal message, so the receive
  // path must unpad it and register the sender key; a later group message from
  // the same chain then decrypts.
  const GROUP2 = '120363000000000099@g.us'
  const wireDist = await bobRepo.createSenderKeyDistribution(GROUP2, BOB, 0)
  const skdmWire = await bobRepo.encryptMessage(
    ME_JID,
    writeRandomPadMax16(
      encodeMessage({ senderKeyDistributionMessage: { groupId: GROUP2, axolotlSenderKeyDistributionMessage: wireDist } })
    )
  )
  await feed({
    tag: 'message',
    attrs: { from: GROUP2, participant: BOB_JID, id: 'MSG-SKDM', t: '1700000010' },
    content: [{ tag: 'enc', attrs: { type: skdmWire.type, v: '2' }, content: skdmWire.ciphertext }]
  })
  const g2 = await bobRepo.encryptGroupMessage(GROUP2, BOB, 0, writeRandomPadMax16(encodeMessage({ conversation: 'skdm-ok' })))
  const g2Msg = await feed({
    tag: 'message',
    attrs: { from: GROUP2, participant: BOB_JID, id: 'MSG-G2', t: '1700000011' },
    content: [{ tag: 'enc', attrs: { type: 'skmsg', v: '2' }, content: g2 }]
  })
  check('padded wire SKDM registered', g2Msg?.message.conversation === 'skdm-ok', JSON.stringify(g2Msg?.message))

  // ── acks mirror WA Web's buildAckStanza ──────────────────────────────────
  const ackForSelf = acks.find(a => a.tag === 'ack' && a.attrs.id === 'MSG-SELF')
  check('ack sent to original from', ackForSelf?.attrs.to === ME_DEVICE_JID, ackForSelf?.attrs.to)
  check('ack class is message', ackForSelf?.attrs.class === 'message', ackForSelf?.attrs.class)
  // device 0 is normalized off the JID on the wire
  check('message ack carries our id as from', ackForSelf?.attrs.from === ME_JID, ackForSelf?.attrs.from)
  check('self-echo ack forwards recipient', ackForSelf?.attrs.recipient === BOB_JID, ackForSelf?.attrs.recipient)

  const ackForGroup = acks.find(a => a.tag === 'ack' && a.attrs.id === 'MSG-GROUP-BOB')
  check('group ack forwards participant', ackForGroup?.attrs.participant === BOB_JID, ackForGroup?.attrs.participant)

  // ── undecryptable message: retry receipt + NACK (error=500) ──────────────
  const beforeAcks = acks.length
  await (client as any).handleIncomingMessage({
    tag: 'message',
    attrs: { from: BOB_JID, id: 'MSG-BAD', t: '1700000004' },
    content: [{ tag: 'enc', attrs: { type: 'msg', v: '2' }, content: Buffer.from('garbage') }]
  })
  for (let i = 0; i < 100 && acks.length === beforeAcks; i++) await new Promise(r => setTimeout(r, 5))
  const nack = acks.find(a => a.tag === 'ack' && a.attrs.id === 'MSG-BAD')
  check('undecryptable message NACKed', nack?.attrs.error === '500', nack?.attrs.error)
  const retry = acks.find(a => a.tag === 'receipt' && a.attrs.id === 'MSG-BAD' && a.attrs.type === 'retry')
  check('undecryptable message retry-receipted', !!retry)

  console.log(`\n${pass}/${total} receive pipeline checks passed`)
  if (pass !== total) process.exitCode = 1
}

run().catch(e => {
  console.error(e)
  process.exitCode = 1
})
