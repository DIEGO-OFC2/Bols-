/**
 * Interop test for media key derivation against Baileys' getMediaKeys.
 * If both derive the same IV/cipher/MAC keys from a fixed media key, the AES
 * and HMAC layers are guaranteed to interoperate.
 */
import { createDecipheriv, createHmac, createCipheriv } from 'node:crypto'
import { decryptMedia, encryptMedia, getMediaKeys } from '../src/media/index.js'
import { importBaileys, baileysDir, skip } from './reference.js'

if (!baileysDir()) skip('media interop')
// Baileys pulls in a native (Rust) bridge for getMediaKeys; load it lazily and
// skip if the bridge is not built for this platform.
const ref: any = await importBaileys('lib/Utils/messages-media.js')
if (!ref) skip('media interop (native bridge unavailable)')

let total = 0
let pass = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const run = async () => {
  for (const type of ['image', 'video', 'audio', 'document', 'ptt']) {
    const mediaKey = Buffer.alloc(32, 3)
    const ours = getMediaKeys(mediaKey, type as any)
    const theirs = await ref.getMediaKeys(mediaKey, type)
    check(`${type} iv matches`, ours.iv.equals(theirs.iv), `${ours.iv.toString('hex')} vs ${theirs.iv.toString('hex')}`)
    check(`${type} cipherKey matches`, ours.cipherKey.equals(theirs.cipherKey))
    check(`${type} macKey matches`, ours.macKey.equals(theirs.macKey))
  }

  // Full encrypt/decrypt round trip and reference-compatible ciphertext.
  const plaintext = Buffer.from('a'.repeat(1000))
  const enc = encryptMedia(plaintext, 'image')
  check('round trip decrypts', decryptMedia(enc.encrypted, enc.mediaKey, 'image').equals(plaintext))

  const refKeys = await ref.getMediaKeys(enc.mediaKey, 'image')
  const decipher = createDecipheriv('aes-256-cbc', refKeys.cipherKey, refKeys.iv)
  const refPlain = Buffer.concat([
    decipher.update(enc.encrypted.subarray(0, enc.encrypted.length - 10)),
    decipher.final()
  ])
  check('reference decrypts lightwa ciphertext', refPlain.equals(plaintext))

  // Reference encrypts; lightwa decrypts.
  const mediaKey = Buffer.alloc(32, 9)
  const rk = await ref.getMediaKeys(mediaKey, 'video')
  const c = createCipheriv('aes-256-cbc', rk.cipherKey, rk.iv)
  const ct = Buffer.concat([c.update(plaintext), c.final()])
  const mac = createHmac('sha256', rk.macKey).update(rk.iv).update(ct).digest().subarray(0, 10)
  check('lightwa decrypts reference ciphertext', decryptMedia(Buffer.concat([ct, mac]), mediaKey, 'video').equals(plaintext))

  console.log(`\n${pass}/${total} media interop checks passed`)
  if (pass !== total) process.exitCode = 1
}

run().catch(e => {
  console.error(e)
  process.exitCode = 1
})
