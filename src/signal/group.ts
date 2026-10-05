/**
 * Signal sender-key (group) messaging, matching WhatsApp's group cipher:
 * a per-(group, sender) chain key that fans out as a SenderKeyDistributionMessage
 * and is then used to encrypt with AES-CBC + an Ed25519-ish signature.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto'
import { Curve, generateSignalPubKey } from '../crypto/index.js'
import { ProtoReader, ProtoWriter } from '../proto/writer.js'
import { deriveSecrets, hmac, asBuffer, CHAIN_MSG, CHAIN_NEXT } from './session.js'

const CURRENT_VERSION = 3
const MAX_MESSAGE_KEYS = 2000
const MAX_STATES = 5

const EMPTY_32 = Buffer.alloc(32)
const WHISPER_GROUP_INFO = Buffer.from('WhisperGroup')

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

interface SenderKeyDistribution {
  id: number
  iteration: number
  chainKey: Buffer
  signingKey: Buffer
}

interface SenderKeyMsg {
  id: number
  iteration: number
  ciphertext: Buffer
}

export const encodeSenderKeyDistribution = (m: SenderKeyDistribution): Buffer =>
  new ProtoWriter().uint32(1, m.id).uint32(2, m.iteration).bytes(3, m.chainKey).bytes(4, m.signingKey).finish()

export const decodeSenderKeyDistribution = (buf: Uint8Array): SenderKeyDistribution => {
  const reader = new ProtoReader(Buffer.from(buf))
  const out: SenderKeyDistribution = { id: 0, iteration: 0, chainKey: Buffer.alloc(0), signingKey: Buffer.alloc(0) }
  for (let f = reader.next(); f; f = reader.next()) {
    if (f.field === 1) out.id = Number(f.value)
    else if (f.field === 2) out.iteration = Number(f.value)
    else if (f.field === 3) out.chainKey = f.value as Buffer
    else if (f.field === 4) out.signingKey = f.value as Buffer
  }
  return out
}

const encodeSenderKeyMessage = (m: SenderKeyMsg): Buffer =>
  new ProtoWriter().uint32(1, m.id).uint32(2, m.iteration).bytes(3, m.ciphertext).finish()

const decodeSenderKeyMessage = (buf: Uint8Array): SenderKeyMsg => {
  const reader = new ProtoReader(Buffer.from(buf))
  const out: SenderKeyMsg = { id: 0, iteration: 0, ciphertext: Buffer.alloc(0) }
  for (let f = reader.next(); f; f = reader.next()) {
    if (f.field === 1) out.id = Number(f.value)
    else if (f.field === 2) out.iteration = Number(f.value)
    else if (f.field === 3) out.ciphertext = f.value as Buffer
  }
  return out
}

// ---------------------------------------------------------------------------
// Chain / message keys
// ---------------------------------------------------------------------------

/** SenderMessageKey: derive IV + cipher key from the chain seed via HKDF. */
const messageKeyFromSeed = (seed: Uint8Array): { iv: Buffer; cipherKey: Buffer } => {
  const derivative = deriveSecrets(Buffer.from(seed), EMPTY_32, WHISPER_GROUP_INFO)
  const d0 = derivative[0]!
  const cipherKey = Buffer.allocUnsafe(32)
  d0.copy(cipherKey, 0, 16, 32)
  derivative[1]!.copy(cipherKey, 16, 0, 16)
  return { iv: d0.subarray(0, 16), cipherKey }
}

const chainNext = (seed: Uint8Array): Buffer => hmac(asBuffer(seed), CHAIN_NEXT)
const chainMessageSeed = (seed: Uint8Array): Buffer => hmac(asBuffer(seed), CHAIN_MSG)

// ---------------------------------------------------------------------------
// State (serializable, mirrors libsignal's JSON shape)
// ---------------------------------------------------------------------------

interface SenderMessageKeyState {
  iteration: number
  seed: string // base64
}

interface SenderKeyState {
  keyId: number
  chainIteration: number
  chainSeed: Buffer
  signingPublic: Buffer
  signingPrivate?: Buffer
  messageKeys: SenderMessageKeyState[]
}

export class SenderKeyRecord {
  private states: SenderKeyState[] = []

  static deserialize(data: any): SenderKeyRecord {
    const rec = new SenderKeyRecord()
    rec.states = (data ?? []).map((s: any) => ({
      keyId: s.senderKeyId,
      chainIteration: s.senderChainKey.iteration,
      chainSeed: Buffer.from(s.senderChainKey.seed, 'base64'),
      signingPublic: Buffer.from(s.senderSigningKey.public, 'base64'),
      signingPrivate: s.senderSigningKey.private ? Buffer.from(s.senderSigningKey.private, 'base64') : undefined,
      messageKeys: (s.senderMessageKeys ?? []).map((k: any) => ({ iteration: k.iteration, seed: k.seed }))
    }))
    return rec
  }

  serialize(): object {
    return this.states.map(s => ({
      senderKeyId: s.keyId,
      senderChainKey: { iteration: s.chainIteration, seed: s.chainSeed.toString('base64') },
      senderSigningKey: {
        public: s.signingPublic.toString('base64'),
        private: s.signingPrivate?.toString('base64')
      },
      senderMessageKeys: s.messageKeys
    }))
  }

  isEmpty(): boolean {
    return this.states.length === 0
  }

  getState(keyId?: number): SenderKeyState | undefined {
    if (keyId === undefined) return this.states[this.states.length - 1]
    return this.states.find(s => s.keyId === keyId)
  }

  addState(id: number, iteration: number, chainKey: Uint8Array, signingPublic: Uint8Array): void {
    this.states.push({
      keyId: id,
      chainIteration: iteration,
      chainSeed: Buffer.from(chainKey),
      signingPublic: Buffer.from(signingPublic),
      messageKeys: []
    })
    if (this.states.length > MAX_STATES) this.states.shift()
  }

  setState(id: number, iteration: number, chainKey: Uint8Array, signing: { public: Buffer; private: Buffer }): void {
    this.states = [
      {
        keyId: id,
        chainIteration: iteration,
        chainSeed: Buffer.from(chainKey),
        signingPublic: signing.public,
        signingPrivate: signing.private,
        messageKeys: []
      }
    ]
  }
}

export interface SenderKeyStore {
  loadSenderKey(name: string): Promise<SenderKeyRecord>
  storeSenderKey(name: string, record: SenderKeyRecord): Promise<void>
}

export const senderKeyName = (group: string, senderId: string, deviceId: number): string =>
  `${group}::${senderId}::${deviceId}`

// ---------------------------------------------------------------------------
// Distribution + cipher
// ---------------------------------------------------------------------------

/** serialized DistributionMessage: [version][proto], used inside an Skdm. */
export const buildSenderKeyDistribution = async (
  store: SenderKeyStore,
  name: string
): Promise<{ record: SenderKeyRecord; serialized: Buffer }> => {
  const record = await store.loadSenderKey(name)
  if (record.isEmpty()) {
    const kp = Curve.generateKeyPair()
    record.setState(
      randomInt(2147483647),
      0,
      randomBytes(32),
      { public: Buffer.from(generateSignalPubKey(kp.public)), private: Buffer.from(kp.private) }
    )
    await store.storeSenderKey(name, record)
  }
  const state = record.getState()!
  const proto = encodeSenderKeyDistribution({
    id: state.keyId,
    iteration: state.chainIteration,
    chainKey: state.chainSeed,
    signingKey: state.signingPublic
  })
  return { record, serialized: Buffer.concat([Buffer.from([(CURRENT_VERSION << 4) | CURRENT_VERSION]), proto]) }
}

export const processSenderKeyDistribution = async (
  store: SenderKeyStore,
  name: string,
  serialized: Uint8Array
): Promise<void> => {
  const dist = decodeSenderKeyDistribution(Buffer.from(serialized).subarray(1))
  const record = await store.loadSenderKey(name)
  record.addState(dist.id, dist.iteration, dist.chainKey, dist.signingKey)
  await store.storeSenderKey(name, record)
}

export const hasSenderKey = async (store: SenderKeyStore, name: string): Promise<boolean> =>
  !(await store.loadSenderKey(name)).isEmpty()

/** Advance the chain to `iteration`, mirroring libsignal's getSenderKey step. */
const getSenderKeySeed = (state: SenderKeyState, iteration: number): Buffer => {
  if (state.chainIteration > iteration) {
    const idx = state.messageKeys.findIndex(k => k.iteration === iteration)
    if (idx === -1) throw new Error(`Old counter ${state.chainIteration} > ${iteration}`)
    const mk = state.messageKeys[idx]!
    state.messageKeys.splice(idx, 1)
    return Buffer.from(mk.seed, 'base64')
  }
  if (iteration - state.chainIteration > 2000) throw new Error('Over 2000 messages into the future')

  let iter = state.chainIteration
  let seed = state.chainSeed
  while (iter < iteration) {
    state.messageKeys.push({ iteration: iter, seed: chainMessageSeed(seed).toString('base64') })
    seed = chainNext(seed)
    iter++
  }
  // A peer can keep jumping the counter forward; without this the retained
  // skipped-key list grows without bound over a long-lived session.
  if (state.messageKeys.length > MAX_MESSAGE_KEYS) {
    state.messageKeys.splice(0, state.messageKeys.length - MAX_MESSAGE_KEYS)
  }
  state.chainSeed = chainNext(seed)
  state.chainIteration = iter + 1
  return chainMessageSeed(seed)
}

/** Encrypt with the existing sender key. Returns the serialized SenderKeyMessage. */
export const encryptGroupMessage = async (
  store: SenderKeyStore,
  name: string,
  plaintext: Uint8Array
): Promise<Buffer> => {
  const record = await store.loadSenderKey(name)
  const state = record.getState()
  if (!state) throw new Error('No sender key state to encrypt')

  const target = state.chainIteration === 0 ? 0 : state.chainIteration + 1
  const messageSeed = getSenderKeySeed(state, target)
  const { iv, cipherKey } = messageKeyFromSeed(messageSeed)
  const ciphertext = encryptCBC(cipherKey, Buffer.from(plaintext), iv)

  const version = (CURRENT_VERSION << 4) | CURRENT_VERSION
  const proto = encodeSenderKeyMessage({ id: state.keyId, iteration: target, ciphertext })
  const toSign = Buffer.concat([Buffer.from([version]), proto])
  const signature = Curve.sign(state.signingPrivate!, toSign)
  await store.storeSenderKey(name, record)

  return Buffer.concat([Buffer.from([version]), proto, signature])
}

export const decryptGroupMessage = async (
  store: SenderKeyStore,
  name: string,
  data: Uint8Array
): Promise<Buffer> => {
  const buf = Buffer.from(data)
  const proto = buf.subarray(1, buf.length - 64)
  const signature = buf.subarray(-64)
  const msg = decodeSenderKeyMessage(proto)

  const record = await store.loadSenderKey(name)
  const state = record.getState(msg.id)
  if (!state) throw new Error('No sender key state to decrypt')

  if (!Curve.verify(state.signingPublic, Buffer.concat([buf.subarray(0, 1), proto]), signature)) {
    throw new Error('Invalid sender key signature')
  }

  const messageSeed = getSenderKeySeed(state, msg.iteration)
  const { iv, cipherKey } = messageKeyFromSeed(messageSeed)
  const plaintext = decryptCBC(cipherKey, msg.ciphertext, iv)
  await store.storeSenderKey(name, record)
  return plaintext
}

const encryptCBC = (key: Buffer, data: Buffer, iv: Buffer): Buffer => {
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

const decryptCBC = (key: Buffer, data: Buffer, iv: Buffer): Buffer => {
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(data), decipher.final()])
}
