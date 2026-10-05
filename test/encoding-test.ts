// Regression coverage for the binary-encoder token table and the HKDF info
// precomputation: both are easy to break in ways that only show up on
// specific inputs or under load.
import { hkdfSync } from 'node:crypto'
import { encodeBinaryNode } from '../src/wabinary/encode.js'
import { decodeBinaryNode } from '../src/wabinary/decode.js'
import { hkdf } from '../src/crypto/index.js'
import { getMediaKeys } from '../src/media/index.js'
import type { BinaryNode } from '../src/wabinary/types.js'

let pass = 0
let total = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.error(`  FAIL ${label} ${extra}`)
}

const contentToString = (c: BinaryNode['content']): string =>
  typeof c === 'string' ? c : c instanceof Uint8Array ? Buffer.from(c).toString('utf8') : ''

// Strings that also exist on Object.prototype must not be mistaken for tokens.
// (As attribute keys only: an attribute named `__proto__` is a decoder-side
// limitation shared with Baileys, which also stores attributes in a plain
// object, so it is intentionally not asserted here.)
const PROTOTYPE_KEYS = [
  'toString',
  'constructor',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString'
]
for (const key of PROTOTYPE_KEYS) {
  const node: BinaryNode = { tag: 'iq', attrs: { [key]: key }, content: key }
  const round = decodeBinaryNode(encodeBinaryNode(node))
  check(
    `prototype key ${key} round-trips`,
    round.attrs[key] === key && contentToString(round.content) === key,
    `\n  got ${JSON.stringify(round)}`
  )
}

// HKDF must treat a pre-encoded Uint8Array info identically to a string.
const ikm = Buffer.alloc(32, 2)
const salt = Buffer.alloc(32)
const infoStr = 'WhatsApp Image Keys'
const asString = hkdf(ikm, 112, { salt, info: infoStr })
const asBytes = hkdf(ikm, 112, { salt, info: Buffer.from(infoStr) })
const asOpenssl = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(infoStr), 112))
check('hkdf string info matches OpenSSL', asString.equals(asOpenssl))
check('hkdf Uint8Array info matches string info', asBytes.equals(asString))

// getMediaKeys must be unchanged by the info precomputation.
const mediaKey = Buffer.alloc(32, 3)
const mediaExpanded = Buffer.from(
  hkdfSync('sha256', mediaKey, salt, Buffer.from('WhatsApp Image Keys'), 112)
)
const mediaKeys = getMediaKeys(mediaKey, 'image')
check('getMediaKeys iv', mediaKeys.iv.equals(mediaExpanded.subarray(0, 16)))
check('getMediaKeys cipherKey', mediaKeys.cipherKey.equals(mediaExpanded.subarray(16, 48)))
check('getMediaKeys macKey', mediaKeys.macKey.equals(mediaExpanded.subarray(48, 80)))

console.log(`${pass}/${total} encoding checks passed`)
process.exit(pass === total ? 0 : 1)
