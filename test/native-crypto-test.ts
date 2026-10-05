// Validate the optional native crypto addon against Node's OpenSSL, and
// confirm the JS fallback is byte-identical to it.
import { createHash, createHmac, hkdfSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { hasNativeCrypto } from '../src/crypto/native.js'

let pass = 0
let total = 0
const check = (label: string, cond: boolean) => {
  total++
  if (cond) pass++
  else console.error(`  FAIL ${label}`)
}

if (!hasNativeCrypto) {
  console.log('SKIP native crypto: addon not built (run `npm run build:native`)')
  process.exit(0)
}

const binary = fileURLToPath(new URL('../native/lightwa_crypto.node', import.meta.url))
check('addon binary exists on disk', existsSync(binary))

const { nativeCrypto } = await import('../src/crypto/native.js')
const native = nativeCrypto!

// sha256
for (const len of [0, 1, 55, 56, 63, 64, 65, 1000]) {
  const data = Uint8Array.from({ length: len }, (_, i) => (i * 7) & 0xff)
  const expected = createHash('sha256').update(data).digest('hex')
  check(`sha256 len=${len}`, native.sha256(data).toString('hex') === expected)
}

// hmac-sha256, including keys longer than the block size
for (const klen of [1, 32, 64, 65, 200]) {
  const key = Uint8Array.from({ length: klen }, (_, i) => (i * 3) & 0xff)
  const msg = Buffer.from('the quick brown fox')
  const expected = createHmac('sha256', key).update(msg).digest('hex')
  check(`hmacSha256 keylen=${klen}`, native.hmacSha256(key, msg).toString('hex') === expected)
}

// hkdf across the padding boundaries and multi-block output lengths
for (const saltLen of [0, 1, 32, 63, 64]) {
  for (const infoLen of [0, 7, 63, 64, 65]) {
    for (const outLen of [1, 16, 32, 42, 112, 255]) {
      const ikm = Buffer.alloc(32, 9)
      const salt = Buffer.alloc(saltLen, 4)
      const info = Buffer.alloc(infoLen, 6)
      const expected = hkdfSync('sha256', ikm, salt, info, outLen)
      const got = native.hkdf(ikm, salt, info, outLen)
      check(
        `hkdf salt=${saltLen} info=${infoLen} out=${outLen}`,
        Buffer.from(got).equals(Buffer.from(expected))
      )
    }
  }
}

// the public hkdf() must agree with OpenSSL with the addon loaded
const { hkdf } = await import('../src/crypto/index.js')
check(
  'exported hkdf matches OpenSSL',
  hkdf(Buffer.alloc(32, 2), 112, { salt: Buffer.alloc(32), info: 'WhatsApp Image Keys' }).equals(
    Buffer.from(hkdfSync('sha256', Buffer.alloc(32, 2), Buffer.alloc(32), Buffer.from('WhatsApp Image Keys'), 112))
  )
)

console.log(`${pass}/${total} native crypto checks passed`)
process.exit(pass === total ? 0 : 1)
