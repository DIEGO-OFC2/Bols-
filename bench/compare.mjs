/**
 * Head-to-head benchmark: lightwa vs Baileys rc14 on the pure-CPU hot paths
 * both libraries expose — binary node encode/decode, message protobuf
 * encode/decode, media key derivation and crypto primitives.
 *
 * This is an apples-to-apples microbenchmark of the codec/crypto layers. It
 * does NOT cover socket/IO or real-server behaviour (network-bound).
 *
 * Usage:  npm run bench
 * Requires the Baileys reference at /tmp/wa-bench/node_modules/baileys.
 */
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

let refDir
try {
  refDir = dirname(require.resolve('baileys/package.json'))
} catch {
  console.log('SKIP: baileys not installed (npm i -D baileys)')
  process.exit(0)
}

const baileys = require(refDir)
const refMedia = await import(refDir + '/lib/Utils/messages-media.js')
const lightwa = {
  ...(await import('../dist/wabinary/index.js')),
  ...(await import('../dist/proto/message.js')),
  ...(await import('../dist/media/index.js')),
  ...(await import('../dist/crypto/index.js'))
}

const sampleNode = {
  tag: 'message',
  attrs: { to: '15550000001@s.whatsapp.net', id: '3EB0ABC123', type: 'text' },
  content: [
    { tag: 'to', attrs: { jid: '15550000001@s.whatsapp.net' }, content: [{ tag: 'enc', attrs: { v: '2', type: 'msg' }, content: Buffer.alloc(64, 1) }] },
    { tag: 'device-identity', attrs: {}, content: Buffer.alloc(50, 2) }
  ]
}
const sampleMessage = { conversation: 'hello world' }
const mediaKey = Buffer.alloc(32, 3)

const kpA = lightwa.Curve.generateKeyPair()
const kpB = baileys.Curve.generateKeyPair()

const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d })

const benchSync = (fn, iters) => {
  for (let i = 0; i < Math.min(iters, 3000); i++) fn()
  if (global.gc) global.gc()
  const before = process.memoryUsage().heapUsed
  const t0 = performance.now()
  for (let i = 0; i < iters; i++) fn()
  const t1 = performance.now()
  return { ms: t1 - t0, ops: (iters / (t1 - t0)) * 1000, heap: process.memoryUsage().heapUsed - before }
}

const benchAsync = async (fn, iters) => {
  for (let i = 0; i < Math.min(iters, 3000); i++) await fn()
  if (global.gc) global.gc()
  const before = process.memoryUsage().heapUsed
  const t0 = performance.now()
  for (let i = 0; i < iters; i++) await fn()
  const t1 = performance.now()
  return { ms: t1 - t0, ops: (iters / (t1 - t0)) * 1000, heap: process.memoryUsage().heapUsed - before }
}

const report = (label, iters, a, b) => {
  const ratio = a.ops / b.ops
  console.log(`\n${label}  (${fmt(iters)} iterations)`)
  console.log(`  lightwa  ${fmt(a.ops)} ops/s   ${fmt(a.ms, 1)} ms   heap-delta ${fmt(a.heap)} B`)
  console.log(`  baileys  ${fmt(b.ops)} ops/s   ${fmt(b.ms, 1)} ms   heap-delta ${fmt(b.heap)} B`)
  console.log(`  -> lightwa ${ratio >= 1 ? fmt(ratio, 2) + 'x faster' : fmt(1 / ratio, 2) + 'x slower'}`)
}

const results = []
// Alternate who runs first across rounds and keep the best sample. This removes
// the consistent-run-order and GC-timing bias a single back-to-back pass has.
const ROUNDS = 3
const better = (a, b) => (a.ops >= b.ops ? a : b)
const pairSync = (label, a, b, iters) => {
  let bestA = { ops: 0, ms: 0, heap: 0 }
  let bestB = { ops: 0, ms: 0, heap: 0 }
  for (let r = 0; r < ROUNDS; r++) {
    const aFirst = r % 2 === 0
    const x = benchSync(aFirst ? a : b, iters)
    const y = benchSync(aFirst ? b : a, iters)
    const [ra, rb] = aFirst ? [x, y] : [y, x]
    bestA = better(bestA, ra)
    bestB = better(bestB, rb)
  }
  report(label, iters, bestA, bestB)
  results.push([label, bestA.ops, bestB.ops])
}
const pairAsync = async (label, a, b, iters) => {
  let bestA = { ops: 0, ms: 0, heap: 0 }
  let bestB = { ops: 0, ms: 0, heap: 0 }
  for (let r = 0; r < ROUNDS; r++) {
    const aFirst = r % 2 === 0
    const x = await benchAsync(aFirst ? a : b, iters)
    const y = await benchAsync(aFirst ? b : a, iters)
    const [ra, rb] = aFirst ? [x, y] : [y, x]
    bestA = better(bestA, ra)
    bestB = better(bestB, rb)
  }
  report(label, iters, bestA, bestB)
  results.push([label, bestA.ops, bestB.ops])
}

console.log('=== lightwa vs baileys rc14 ===')

// binary encode/decode
const lightEncoded = lightwa.encodeBinaryNode(sampleNode)
const refEncoded = baileys.encodeBinaryNode(sampleNode)
pairSync(
  'encodeBinaryNode',
  () => lightwa.encodeBinaryNode(sampleNode),
  () => baileys.encodeBinaryNode(sampleNode),
  200_000
)
console.log(`  (frame sizes: lightwa ${lightEncoded.length} B, baileys ${refEncoded.length} B)`)
await pairAsync(
  'decodeBinaryNode',
  () => lightwa.decodeBinaryNode(Uint8Array.from(lightEncoded)),
  () => baileys.decodeBinaryNode(Buffer.from(refEncoded)),
  200_000
)

// protobuf message
await pairAsync(
  'encode message (protobuf)',
  () => lightwa.encodeMessage(sampleMessage),
  () => baileys.WAProto.Message.encode(baileys.WAProto.Message.create(sampleMessage)).finish(),
  200_000
)
const lightMsg = lightwa.encodeMessage(sampleMessage)
const refMsg = Buffer.from(baileys.WAProto.Message.encode(baileys.WAProto.Message.create(sampleMessage)).finish())
await pairAsync(
  'decode message (protobuf)',
  () => lightwa.decodeMessage(lightMsg),
  () => baileys.WAProto.Message.decode(refMsg),
  200_000
)

// media keys
await pairAsync(
  'getMediaKeys',
  () => lightwa.getMediaKeys(mediaKey, 'image'),
  () => refMedia.getMediaKeys(mediaKey, 'image'),
  100_000
)

// crypto
pairSync('Curve.generateKeyPair', () => lightwa.Curve.generateKeyPair(), () => baileys.Curve.generateKeyPair(), 20_000)
pairSync('Curve.sharedKey', () => lightwa.Curve.sharedKey(kpA.private, kpA.public), () => baileys.Curve.sharedKey(kpB.private, kpB.public), 20_000)
pairSync('hkdf', () => lightwa.hkdf(Buffer.alloc(32, 1), 32, { info: 'test' }), () => baileys.hkdf(Buffer.alloc(32, 1), 32, { info: 'test' }), 100_000)

// Double Ratchet (steady-state encrypt) and X3DH session setup vs the libsignal
// engine that Baileys embeds — the real per-message E2E cost.
let libsignal
try {
  libsignal = require('libsignal')
} catch {
  libsignal = null
}
if (libsignal) {
  const lwSig = await import('../dist/signal/session.js')
  const toSignal = kp => ({ privKey: Buffer.from(kp.private), pubKey: Buffer.from(lightwa.generateSignalPubKey(kp.public)) })
  const makeBundle = () => {
    const id = toSignal(lightwa.Curve.generateKeyPair())
    const spk = lightwa.signedKeyPair({ private: id.privKey, public: id.pubKey.subarray(1) }, 1)
    const spkPair = { privKey: Buffer.from(spk.keyPair.private), pubKey: Buffer.from(lightwa.generateSignalPubKey(spk.keyPair.public)) }
    const pk = toSignal(lightwa.Curve.generateKeyPair())
    return {
      registrationId: 5555,
      identityKey: id.pubKey,
      signedPreKey: { keyId: 1, publicKey: spkPair.pubKey, signature: spk.signature },
      preKey: { keyId: 7, publicKey: pk.pubKey }
    }
  }
  const lwIdentity = toSignal(lightwa.Curve.generateKeyPair())
  const lwSessions = new Map()
  const lwStorage = {
    loadSession: async id => lwSessions.get(id) ?? null,
    storeSession: async (id, r) => void lwSessions.set(id, r),
    isTrustedIdentity: async () => true,
    loadPreKey: async () => undefined,
    removePreKey: async () => {},
    loadSignedPreKey: async () => ({ privKey: Buffer.alloc(32), pubKey: Buffer.alloc(33) }),
    getOurRegistrationId: () => 1,
    getOurIdentity: () => lwIdentity
  }
  const lwSetup = async () => {
    lwSessions.clear()
    await new lwSig.SessionBuilder(lwStorage, 'bob').initOutgoing(makeBundle())
    return new lwSig.SessionCipher(lwStorage, 'bob')
  }

  const sigAddr = new libsignal.ProtocolAddress('bob', 1)
  const sigIdentity = libsignal.curve.generateKeyPair()
  const sigSessions = new Map()
  const sigStorage = {
    loadSession: async id => sigSessions.get(id) ?? null,
    storeSession: async (id, r) => void sigSessions.set(id, r),
    isTrustedIdentity: async () => true,
    loadPreKey: async () => undefined,
    removePreKey: async () => {},
    loadSignedPreKey: async () => ({ privKey: Buffer.alloc(32), pubKey: Buffer.alloc(33) }),
    getOurRegistrationId: () => 1,
    getOurIdentity: () => sigIdentity
  }
  const sigSetup = async () => {
    sigSessions.clear()
    const id = libsignal.curve.generateKeyPair()
    const spk = libsignal.curve.generateKeyPair()
    const pk = libsignal.curve.generateKeyPair()
    await new libsignal.SessionBuilder(sigStorage, sigAddr).initOutgoing({
      registrationId: 5555,
      identityKey: id.pubKey,
      signedPreKey: { keyId: 1, publicKey: spk.pubKey, signature: libsignal.curve.calculateSignature(spk.privKey, spk.pubKey) },
      preKey: { keyId: 7, publicKey: pk.pubKey }
    })
    return new libsignal.SessionCipher(sigStorage, sigAddr)
  }

  const lwCipher = await lwSetup()
  const sigCipher = await sigSetup()
  await pairAsync(
    'ratchet encrypt (steady state)',
    () => lwCipher.encrypt(Buffer.from('hello world message')),
    () => sigCipher.encrypt(Buffer.from('hello world message')),
    3_000
  )
  await pairAsync('session setup (X3DH)', lwSetup, sigSetup, 1_500)

  // Group (sender-key) cipher: encrypt signs with XEdDSA, decrypt verifies.
  // Both sides pre-generate ciphertexts so the measured path is the cipher,
  // not the chain advance.
  const lwGroup = await import('../dist/signal/group.js')
  const refGroup = await import(refDir + '/lib/Signal/Group/index.js')
  const refRecord = await import(refDir + '/lib/Signal/Group/sender-key-record.js')

  const mkSenderStore = () => {
    const m = new Map()
    return { loadSenderKey: async n => m.get(n.toString()) ?? new refRecord.SenderKeyRecord(), storeSenderKey: async (n, r) => void m.set(n.toString(), r) }
  }
  const addr = new libsignal.ProtocolAddress('15550000001', 1)
  const refName = new refGroup.SenderKeyName('group@g.us', addr)
  const refStore = mkSenderStore()
  const refDist = await new refGroup.GroupSessionBuilder(refStore).create(refName)
  const refCipher = new refGroup.GroupCipher(refStore, refName)
  const refCt = []
  for (let i = 0; i < 5000; i++) refCt.push(await refCipher.encrypt(Buffer.from('hello world group message')))

  const lwSName = 'group@g.us::15550000001::1'
  const lwSender = new Map()
  const mkLwStore = m => ({ loadSenderKey: async n => m.get(n) ?? new lwGroup.SenderKeyRecord(), storeSenderKey: async (n, r) => void m.set(n, r) })
  const lwSenderStore = mkLwStore(lwSender)
  const { serialized: lwDist } = await lwGroup.buildSenderKeyDistribution(lwSenderStore, lwSName)
  const lwCt = []
  for (let i = 0; i < 5000; i++) lwCt.push(await lwGroup.encryptGroupMessage(lwSenderStore, lwSName, Buffer.from('hello world group message')))

  const refRecvStore = mkSenderStore()
  await new refGroup.GroupSessionBuilder(refRecvStore).process(refName, refDist)
  const refRecv = new refGroup.GroupCipher(refRecvStore, refName)

  const lwRecvStore = mkLwStore(new Map())
  await lwGroup.processSenderKeyDistribution(lwRecvStore, lwSName, lwDist)

  let ri = 0
  let li = 0
  await pairAsync(
    'group encrypt (sender key)',
    () => lwGroup.encryptGroupMessage(lwSenderStore, lwSName, Buffer.from('hello world group message')),
    () => refCipher.encrypt(Buffer.from('hello world group message')),
    700
  )
  await pairAsync(
    'group decrypt (sender key)',
    () => lwGroup.decryptGroupMessage(lwRecvStore, lwSName, lwCt[li++ % lwCt.length]),
    () => refRecv.decrypt(refCt[ri++ % refCt.length]),
    700
  )
}

console.log('\n=== summary (ops/s, higher is better) ===')
console.log('  path'.padEnd(30) + 'lightwa'.padStart(14) + 'baileys'.padStart(14) + 'ratio'.padStart(10))
for (const [label, lo, re] of results) {
  const ratio = lo / re
  console.log('  ' + label.padEnd(28) + fmt(lo).padStart(14) + fmt(re).padStart(14) + (fmt(ratio, 2) + 'x').padStart(10))
}
console.log('\ndone.')
