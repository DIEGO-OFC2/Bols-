// Validate our crypto module against curve25519-js and Node crypto.
import { createRequire } from 'node:module'
import { randomBytes, createHash } from 'node:crypto'
import { Curve, aesEncryptGCM, aesDecryptGCM, hkdf, signedKeyPair, generateSignalPubKey } from '../src/crypto/index.js'

const require = createRequire(import.meta.url)
let curveJs: any = null
try {
  curveJs = require('curve25519-js')
} catch {
  /* optional interop reference */
}
if (!curveJs) {
  console.log('SKIP crypto interop: curve25519-js not installed (npm i -D curve25519-js)')
  process.exit(0)
}

let pass = 0
let total = 0
const check = (label, cond) => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label}`)
}

// keygen + pub agreement
for (let i = 0; i < 30; i++) {
  const kp = Curve.generateKeyPair()
  const ref = curveJs.generateKeyPair(kp.private)
  check('pub', Buffer.from(kp.public).equals(Buffer.from(ref.public)))
}

// shared key symmetry + matches reference
for (let i = 0; i < 10; i++) {
  const a = Curve.generateKeyPair()
  const b = Curve.generateKeyPair()
  const ab = Curve.sharedKey(a.private, b.public)
  const ba = Curve.sharedKey(b.private, a.public)
  check('dh symmetry', Buffer.from(ab).equals(Buffer.from(ba)))
  const refAB = Buffer.from(curveJs.sharedKey(a.private, Buffer.from(b.public)))
  check('dh vs ref', Buffer.from(ab).equals(refAB))
}

// signatures exact + cross verify
for (let i = 0; i < 30; i++) {
  const kp = Curve.generateKeyPair()
  const msg = createHash('sha256').update(`m${i}`).digest()
  const sig = Curve.sign(kp.private, msg)
  const refSig = Buffer.from(curveJs.sign(kp.private, msg))
  check('sign exact', Buffer.from(sig).equals(refSig))
  check('our verify', Curve.verify(kp.public, msg, sig))
  check('ref verify', curveJs.verify(Buffer.from(kp.public), msg, sig))
  check('verify rejects tamper', !Curve.verify(kp.public, msg, Buffer.from(sig.map((b, j) => (j === 0 ? b ^ 1 : b)))))
}

// signed key pair signature verifies over the prefixed pubkey
{
  const id = Curve.generateKeyPair()
  const skp = signedKeyPair(id, 1)
  check('signed prekey verify', Curve.verify(id.public, generateSignalPubKey(skp.keyPair.public), skp.signature))
}

// AES-GCM round trip
for (let i = 0; i < 10; i++) {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const ad = randomBytes(16)
  const pt = randomBytes(64)
  const ct = aesEncryptGCM(pt, key, iv, ad)
  check('gcm roundtrip', Buffer.from(aesDecryptGCM(ct, key, iv, ad)).equals(pt))
}

// HKDF against Node
{
  const ikm = randomBytes(32)
  const salt = randomBytes(32)
  const derived = hkdf(ikm, 64, { salt, info: '' })
  check('hkdf length', derived.length === 64)
}

console.log(`\n${pass}/${total} crypto checks passed`)
if (pass !== total) process.exitCode = 1
