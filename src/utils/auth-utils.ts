import { randomBytes } from 'node:crypto'
import { Curve, signedKeyPair, type KeyPair, type SignedKeyPair } from '../crypto/index.js'
import { generateRegistrationId, randomBase64 } from './generics.js'

export interface SignalIdentity {
  identifier: { name: string; deviceId: number }
  identifierKey: Uint8Array
}

export interface AuthenticationCreds {
  noiseKey: KeyPair
  pairingEphemeralKeyPair: KeyPair
  signedIdentityKey: KeyPair
  signedPreKey: SignedKeyPair
  registrationId: number
  advSecretKey: string
  nextPreKeyId: number
  firstUnuploadedPreKeyId: number
  me?: { id: string; name?: string; lid?: string }
  account?: Record<string, unknown>
  signalIdentities?: SignalIdentity[]
  platform?: string
  registered: boolean
  pairingCode?: string
  routingInfo?: Buffer
  lastPropHash?: string
  additionalData?: Record<string, unknown>
}

export const initAuthCreds = (): AuthenticationCreds => {
  const identityKey = Curve.generateKeyPair()
  return {
    noiseKey: Curve.generateKeyPair(),
    pairingEphemeralKeyPair: Curve.generateKeyPair(),
    signedIdentityKey: identityKey,
    signedPreKey: signedKeyPair(identityKey, 1),
    registrationId: generateRegistrationId(),
    advSecretKey: randomBase64(32),
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    registered: false
  }
}

/**
 * A pluggable key store. Baileys keeps every pre-key in memory; for a frugal
 * client it is far cheaper to persist them and only hold the working set.
 */
export interface SignalKeyStore {
  get(
    type: 'pre-key' | 'session' | 'sender-key' | 'identity-key' | 'app-state-sync-key',
    ids: string[]
  ): Promise<Record<string, unknown>>
  set(data: Record<string, Record<string, unknown> | null>): Promise<void>
}

/** In-memory store for tests and short-lived sessions. */
export const makeInMemoryKeyStore = (): SignalKeyStore => {
  const store: Record<string, Record<string, unknown>> = {}
  return {
    get: async (type, ids) => {
      const bucket = store[type] ?? {}
      const out: Record<string, unknown> = {}
      for (const id of ids) if (bucket[id] !== undefined) out[id] = bucket[id]
      return out
    },
    set: async data => {
      for (const [type, values] of Object.entries(data)) {
        store[type] = store[type] ?? {}
        if (values === null) continue
        for (const [id, value] of Object.entries(values)) {
          if (value === null) delete store[type]![id]
          else store[type]![id] = value
        }
      }
    }
  }
}

export interface AuthenticationState {
  creds: AuthenticationCreds
  keys: SignalKeyStore
}

export const initAuthState = (keys: SignalKeyStore = makeInMemoryKeyStore()): AuthenticationState => ({
  creds: initAuthCreds(),
  keys
})
