/**
 * Interop test: one side runs the reference libsignal, the other runs lightwa's
 * Signal implementation. If they can hold a conversation across several ratchet
 * steps, the session setup and Double Ratchet are wire-compatible.
 */
import { Curve, generateSignalPubKey, signedKeyPair } from '../src/crypto/index.js'
import { loadLibsignal, baileysParent, skip } from './reference.js'
import {
  SessionBuilder,
  SessionCipher,
  SessionRecord
} from '../src/signal/session.js'
import type { SignalKeyPair, SignalStorage, PreKeyBundle } from '../src/signal/session.js'

const libsignal: any = loadLibsignal()
if (!libsignal) skip('signal interop')

let total = 0
let pass = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const toSignal = (kp: { private: Uint8Array; public: Uint8Array }): SignalKeyPair => ({
  privKey: Buffer.from(kp.private),
  pubKey: Buffer.from(generateSignalPubKey(kp.public))
})

// ---------------------------------------------------------------------------
// Bob: lightwa side
// ---------------------------------------------------------------------------
const bobIdentity = toSignal(Curve.generateKeyPair())
const bobSignedKp = signedKeyPair(
  { private: bobIdentity.privKey, public: bobIdentity.pubKey.subarray(1) },
  1
)
const bobSigned: SignalKeyPair = {
  privKey: Buffer.from(bobSignedKp.keyPair.private),
  pubKey: Buffer.from(generateSignalPubKey(bobSignedKp.keyPair.public))
}
const bobPreKey: SignalKeyPair = (() => {
  const kp = Curve.generateKeyPair()
  return { privKey: Buffer.from(kp.private), pubKey: Buffer.from(generateSignalPubKey(kp.public)) }
})()
const bobRegistrationId = 1234

const bobSessions = new Map<string, SessionRecord>()
const bobPreKeys = new Map<number, SignalKeyPair>([[7, bobPreKey]])
const bobStorage: SignalStorage = {
  loadSession: async id => bobSessions.get(id) ?? null,
  storeSession: async (id, rec) => void bobSessions.set(id, rec),
  isTrustedIdentity: async () => true,
  loadPreKey: async id => bobPreKeys.get(id),
  removePreKey: async id => void bobPreKeys.delete(id),
  loadSignedPreKey: async () => bobSigned,
  getOurRegistrationId: () => bobRegistrationId,
  getOurIdentity: () => bobIdentity
}

// ---------------------------------------------------------------------------
// Alice: reference libsignal side
// ---------------------------------------------------------------------------
const aliceIdentityKp = libsignal.curve.generateKeyPair() // {privKey, pubKey(33)}
const aliceRegistrationId = libsignal.keyhelper.generateRegistrationId()

const aliceStore = new Map<string, any>()
const aliceIdentity = { privKey: aliceIdentityKp.privKey, pubKey: aliceIdentityKp.pubKey }
const aliceStorage = {
  loadSession: async (id: string) => aliceStore.get(id) ?? null,
  storeSession: async (id: string, rec: any) => void aliceStore.set(id, rec),
  isTrustedIdentity: async () => true,
  loadPreKey: async (id: number) => aliceStore.get(`prekey:${id}`),
  removePreKey: async () => {},
  loadSignedPreKey: async () => aliceStore.get('signed'),
  getOurRegistrationId: () => aliceRegistrationId,
  getOurIdentity: () => aliceIdentity
}

const run = async () => {
  const bobAddr = '15550000001.0'
  const aliceAddr = '15550000002.0'

  // Alice initiates a session to Bob using Bob's pre-key bundle.
  const device: PreKeyBundle = {
    registrationId: bobRegistrationId,
    identityKey: bobIdentity.pubKey,
    signedPreKey: {
      keyId: 1,
      publicKey: bobSigned.pubKey,
      signature: Buffer.from(bobSignedKp.signature)
    },
    preKey: { keyId: 7, publicKey: bobPreKey.pubKey }
  }

  const aliceBuilder = new libsignal.SessionBuilder(aliceStorage, new libsignal.ProtocolAddress('15550000001', 0))
  await aliceBuilder.initOutgoing(device)
  check('alice (libsignal) built outgoing session to bob', aliceStore.size > 0)

  const aliceCipher = new libsignal.SessionCipher(aliceStorage, new libsignal.ProtocolAddress('15550000001', 0))
  const bobCipher = new SessionCipher(bobStorage, aliceAddr)

  // 1) Alice -> Bob (prekey message)
  const m1 = await aliceCipher.encrypt(Buffer.from('hello bob'))
  check('alice produces a prekey message', m1.type === 3, `type=${m1.type}`)
  const b1 = await bobCipher.decryptPreKeyWhisperMessage(Buffer.from(m1.body))
  check('bob (lightwa) decrypts alice prekey message', b1.toString() === 'hello bob', b1.toString())

  // 2) Bob -> Alice (now a normal whisper message)
  const m2 = await bobCipher.encrypt(Buffer.from('hi alice'))
  check('bob produces a whisper message', m2.type === 1, `type=${m2.type}`)
  const a2 = await aliceCipher.decryptWhisperMessage(Buffer.from(m2.body))
  check('alice (libsignal) decrypts bob whisper message', a2.toString() === 'hi alice', a2.toString())

  // 3) Several more round trips to exercise the sending chain counter.
  for (let i = 0; i < 5; i++) {
    const a = await aliceCipher.encrypt(Buffer.from(`alice-${i}`))
    const ab = await bobCipher.decryptWhisperMessage(Buffer.from(a.body))
    const b = await bobCipher.encrypt(Buffer.from(`bob-${i}`))
    const ba = await aliceCipher.decryptWhisperMessage(Buffer.from(b.body))
    check(`roundtrip ${i} alice->bob`, ab.toString() === `alice-${i}`)
    check(`roundtrip ${i} bob->alice`, ba.toString() === `bob-${i}`)
  }

  // 4) Out-of-order delivery must still decrypt via the skipped-key cache.
  const p1 = await aliceCipher.encrypt(Buffer.from('ooo-1'))
  const p2 = await aliceCipher.encrypt(Buffer.from('ooo-2'))
  const d2 = await bobCipher.decryptWhisperMessage(Buffer.from(p2.body))
  const d1 = await bobCipher.decryptWhisperMessage(Buffer.from(p1.body))
  check('out-of-order: later message first', d2.toString() === 'ooo-2', d2.toString())
  check('out-of-order: earlier message after', d1.toString() === 'ooo-1', d1.toString())

  // 5) A ratchet step: alice replies twice, bob replies, chains rotate.
  const r1 = await aliceCipher.encrypt(Buffer.from('ratchet-a'))
  await bobCipher.decryptWhisperMessage(Buffer.from(r1.body))
  const r2 = await bobCipher.encrypt(Buffer.from('ratchet-b'))
  const rr2 = await aliceCipher.decryptWhisperMessage(Buffer.from(r2.body))
  check('ratchet step roundtrip', rr2.toString() === 'ratchet-b', rr2.toString())

  // 6) Session record serialization round-trips through JSON.
  const bobRecord = bobSessions.get(aliceAddr)!
  const restored = SessionRecord.deserialize(JSON.parse(JSON.stringify(bobRecord.serialize())) as any)
  const restoredCipher = new SessionCipher(
    { ...bobStorage, loadSession: async () => restored },
    aliceAddr
  )
  const r3 = await aliceCipher.encrypt(Buffer.from('after-reload'))
  const rr3 = await restoredCipher.decryptWhisperMessage(Buffer.from(r3.body))
  check('session survives serialize/deserialize', rr3.toString() === 'after-reload', rr3.toString())

  console.log(`\n${pass}/${total} signal interop checks passed`)
  if (pass !== total) process.exitCode = 1
}

run().catch(e => {
  console.error(e)
  process.exitCode = 1
})
