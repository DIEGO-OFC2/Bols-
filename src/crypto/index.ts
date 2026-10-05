import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js'
import { sha256 as sha256Noble } from '@noble/hashes/sha2.js'
import { nativeCrypto } from './native.js'

const EMPTY_BYTES = new Uint8Array(0)

export interface KeyPair {
  private: Uint8Array
  public: Uint8Array
}

export interface SignedKeyPair {
  keyPair: KeyPair
  signature: Uint8Array
  keyId: number
}

const Point = ed25519.Point
const Fp = Point.Fp
const Fn = Point.Fn
const BASE = Point.BASE

const leToBig = (u8: Uint8Array): bigint => {
  let x = 0n
  for (let i = u8.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(u8[i]!)
  return x
}

const bigToLe32 = (v: bigint): Uint8Array => {
  const out = new Uint8Array(32)
  let x = v
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}

/** Clamp an X25519 private scalar into the Ed25519 private-key form. */
const clampScalar = (raw: Uint8Array): Uint8Array => {
  const sk = new Uint8Array(raw)
  sk[0] = (sk[0]! & 248)
  sk[31] = (sk[31]! & 127) | 64
  return sk
}

const sha512 = (data: Uint8Array): Buffer => createHash('sha512').update(data).digest()

/** Byte lengths of the DER framing OpenSSL puts around a raw X25519 key. */
const PKCS8_HEADER = 16 // 302e...0422 0420
const SPKI_HEADER = 12 // 302a...0321 00

/** Full DER prefixes (the 16/12 version without the raw key) for wrapping raw X25519 keys. */
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

const edwardsPublicFromScalar = (raw: Uint8Array): Uint8Array =>
  BASE.multiply(Fn.create(leToBig(clampScalar(raw)))).toBytes()

/** (u - 1) / (u + 1): X25519 u-coordinate to Ed25519 y-coordinate. */
const montgomeryToEdwardsPublic = (mont: Uint8Array): Uint8Array => {
  const u = Fp.create(leToBig(mont))
  return Fp.toBytes(Fp.div(Fp.sub(u, 1n), Fp.add(u, 1n)))
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

// A sender's XEdDSA signing key is fixed for the life of a sender-key state,
// yet verifying each group message re-derives its Ed25519 form (a ~29µs field
// inversion) and re-parses it into a KeyObject (~25µs). Both depend only on the
// key and its sign bit (a per-key constant carried in `signature[63]`), so cache
// the parsed key. Bounded so a peer flooding distinct keys cannot grow it.
const EDWARDS_CACHE_MAX = 512
const edwardsKeyCache = new Map<string, { A: Uint8Array; key: KeyObject | null }>()

const edwardsKey = (mont: Uint8Array, signBit: number): { A: Uint8Array; key: KeyObject | null } => {
  const cacheKey = `${Buffer.from(mont).toString('base64')}${signBit ? '1' : '0'}`
  const hit = edwardsKeyCache.get(cacheKey)
  if (hit) return hit
  const A = montgomeryToEdwardsPublic(mont)
  A[31] = A[31]! | signBit
  let key: KeyObject | null = null
  try {
    key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(A)]),
      format: 'der',
      type: 'spki'
    })
  } catch {
    key = null
  }
  const entry = { A, key }
  if (edwardsKeyCache.size >= EDWARDS_CACHE_MAX) {
    const oldest = edwardsKeyCache.keys().next().value
    if (oldest !== undefined) edwardsKeyCache.delete(oldest)
  }
  edwardsKeyCache.set(cacheKey, entry)
  return entry
}

/**
 * XEdDSA signatures are Ed25519 signatures over the Ed25519 form of the key,
 * with the key's sign bit carried in the top bit of `s`. Clear that bit from `s`
 * (the cached KeyObject already carries it in the key) and let OpenSSL verify.
 */
const nativeVerifyXEdDSA = (key: KeyObject, message: Uint8Array, signature: Uint8Array): boolean => {
  const s = Buffer.from(signature.subarray(32, 64))
  s[31] = s[31]! & 0x7f
  return cryptoVerify(null, message, key, Buffer.concat([Buffer.from(signature.subarray(0, 32)), s]))
}

export const Curve = {
  generateKeyPair: (): KeyPair => {
    // OpenSSL generates the pair and derives the public key in one call, which
    // is ~1.6x faster than randomBytes + manual DER wrap.
    const { privateKey, publicKey } = generateKeyPairSync('x25519')
    const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8_HEADER)
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_HEADER)
    return { private: Buffer.from(priv), public: Buffer.from(pub) }
  },

  sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array): Buffer => {
    // Accept keys that carry the 0x05 Signal type prefix.
    const pub = publicKey.length === 33 ? publicKey.subarray(1) : publicKey
    if (pub.length !== 32 || privateKey.length !== 32) {
      return Buffer.from(x25519.getSharedSecret(privateKey, pub))
    }
    // OpenSSL's X25519 is ~7x faster than the pure-JS scalar multiplication,
    // and X3DH derives several agreements per session setup.
    try {
      const priv = createPrivateKey({
        key: Buffer.concat([PKCS8_X25519_PREFIX, Buffer.from(privateKey)]),
        format: 'der',
        type: 'pkcs8'
      })
      const peer = createPublicKey({
        key: Buffer.concat([SPKI_X25519_PREFIX, Buffer.from(pub)]),
        format: 'der',
        type: 'spki'
      })
      return diffieHellman({ privateKey: priv, publicKey: peer })
    } catch {
      return Buffer.from(x25519.getSharedSecret(privateKey, pub))
    }
  },

  /** XEdDSA signature (compatible with Signal's curve25519 sign). */
  sign: (privateKey: Uint8Array, message: Uint8Array): Buffer => {
    const sk = clampScalar(privateKey)
    const a = Fn.create(leToBig(sk))
    const A = BASE.multiply(a).toBytes()

    const r = Fn.create(leToBig(sha512(concat(sk, message))))
    const R = BASE.multiply(r).toBytes()
    const h = Fn.create(leToBig(sha512(concat(R, A, message))))
    const s = Fn.add(r, Fn.mul(h, a))

    const sBytes = bigToLe32(s)
    // XEdDSA carries the sign bit of the public key in the top bit of s.
    sBytes[31] = sBytes[31]! | (A[31]! & 128)
    return Buffer.concat([Buffer.from(R), Buffer.from(sBytes)])
  },

  verify: (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean => {
    if (signature.length !== 64) return false
    try {
      // Accept keys that carry the 0x05 Signal type prefix.
      const mont = publicKey.length === 33 ? publicKey.subarray(1) : publicKey
      const { A, key } = edwardsKey(mont, signature[63]! & 128)
      const sBytes = new Uint8Array(signature.subarray(32, 64))
      sBytes[31] = sBytes[31]! & 127

      // OpenSSL's Ed25519 is ~13x the JS scalar-mult path and is on the
      // per-message decrypt hot path. Fall through to noble only when the key
      // could not be parsed (e.g. a malformed point).
      if (key) return nativeVerifyXEdDSA(key, message, signature)

      const s = Fn.create(leToBig(sBytes))
      const expected = BASE.multiply(s).subtract(Point.fromBytes(A).multiply(Fn.create(leToBig(sha512(concat(signature.subarray(0, 32), A, message))))))
      return Buffer.from(expected.toBytes()).equals(Buffer.from(signature.subarray(0, 32)))
    } catch {
      return false
    }
  }
}

const concat = (...parts: Uint8Array[]): Buffer =>
  Buffer.concat(parts.map(p => Buffer.from(p)))

export const generateSignalPubKey = (pubKey: Uint8Array): Uint8Array =>
  pubKey.length === 33 ? pubKey : Buffer.concat([Buffer.from([5]), Buffer.from(pubKey)])

export const signedKeyPair = (identityKeyPair: KeyPair, keyId: number): SignedKeyPair => {
  const preKey = Curve.generateKeyPair()
  const pubKey = generateSignalPubKey(preKey.public)
  const signature = Curve.sign(identityKeyPair.private, pubKey)
  return { keyPair: preKey, signature, keyId }
}

// ---------------------------------------------------------------------------
// Symmetric crypto
// ---------------------------------------------------------------------------

const GCM_TAG_LENGTH = 16

/** AES-256-GCM; the auth tag is appended to the ciphertext. */
export const aesEncryptGCM = (
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  additionalData: Uint8Array
): Buffer => {
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(additionalData)
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

/** AES-256-GCM; expects the auth tag appended to the ciphertext. */
export const aesDecryptGCM = (
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  additionalData: Uint8Array
): Buffer => {
  const tagStart = ciphertext.length - GCM_TAG_LENGTH
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(additionalData)
  decipher.setAuthTag(ciphertext.subarray(tagStart))
  return Buffer.concat([decipher.update(ciphertext.subarray(0, tagStart)), decipher.final()])
}

export const aesEncryptCTR = (plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer => {
  const cipher = createCipheriv('aes-256-ctr', key, iv)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export const aesDecryptCTR = (ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer => {
  const decipher = createDecipheriv('aes-256-ctr', key, iv)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export const aesEncrypt = (plaintext: Uint8Array, key: Uint8Array): Buffer => {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final()])
}

export const aesDecrypt = (ciphertext: Uint8Array, key: Uint8Array): Buffer => {
  const decipher = createDecipheriv('aes-256-cbc', key, ciphertext.subarray(0, 16))
  return Buffer.concat([decipher.update(ciphertext.subarray(16)), decipher.final()])
}

export const hmacSign = (
  buffer: Uint8Array,
  key: Uint8Array,
  variant: 'sha256' | 'sha512' = 'sha256'
): Buffer =>
  variant === 'sha256' && nativeCrypto
    ? nativeCrypto.hmacSha256(key, buffer)
    : createHmac(variant, key).update(buffer).digest()

export const sha256 = (buffer: Uint8Array): Buffer =>
  nativeCrypto ? nativeCrypto.sha256(buffer) : createHash('sha256').update(buffer).digest()

/** Zero-copy view when already a Buffer; a wrapping copy otherwise. */
export const asBuffer = (u: Uint8Array): Buffer =>
  Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength)

export const md5 = (buffer: Uint8Array): Buffer => createHash('md5').update(buffer).digest()

/** HKDF-SHA256 (extract then expand), matching the WebCrypto reference semantics. */
export const hkdf = (
  inputKeyMaterial: Uint8Array,
  expandedLength: number,
  info: { salt?: Uint8Array; info?: string | Uint8Array } = {}
): Buffer => {
  const infoBytes =
    info.info === undefined
      ? EMPTY_BYTES
      : typeof info.info === 'string'
        ? Buffer.from(info.info)
        : info.info
  return nativeCrypto
    ? nativeCrypto.hkdf(inputKeyMaterial, info.salt ?? EMPTY_BYTES, infoBytes, expandedLength)
    : Buffer.from(
        nobleHkdf(
          sha256Noble,
          inputKeyMaterial,
          info.salt ?? EMPTY_BYTES,
          infoBytes,
          expandedLength
        )
      )
}

/** PBKDF2-SHA256 with 131072 iterations, used to derive the pairing-code key. */
export const derivePairingCodeKey = async (pairingCode: string, salt: Uint8Array): Promise<Buffer> => {
  const { pbkdf2Sync } = await import('node:crypto')
  return pbkdf2Sync(pairingCode, salt, 2 << 16, 32, 'sha256')
}

export { edwardsPublicFromScalar }
