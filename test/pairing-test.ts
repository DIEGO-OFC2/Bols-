import { randomBytes } from 'node:crypto'
import {
  Curve,
  aesDecryptGCM,
  aesEncryptCTR,
  derivePairingCodeKey,
  hkdf
} from '../src/crypto/index.js'
import { buildCompanionFinish } from '../src/utils/validate-connection.js'
import { initAuthCreds } from '../src/utils/auth-utils.js'

let total = 0
let pass = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const run = async () => {
  const creds = initAuthCreds()
  const pairingCode = 'ABCD2345'
  creds.pairingCode = pairingCode
  creds.me = { id: '15551234567@s.whatsapp.net' }

  // --- primary device (server side of the pairing flow) ---
  const primaryEphemeral = Curve.generateKeyPair()
  const primaryIdentity = Curve.generateKeyPair()

  const salt = randomBytes(32)
  const iv = randomBytes(16)
  const wrappingKey = await derivePairingCodeKey(pairingCode, salt)
  const wrapped = Buffer.concat([
    salt,
    iv,
    aesEncryptCTR(primaryEphemeral.public, wrappingKey, iv)
  ])

  const stanza: any = {
    tag: 'link_code_companion_reg',
    attrs: {},
    content: [
      { tag: 'link_code_pairing_ref', attrs: {}, content: Buffer.from('REF-XYZ') },
      { tag: 'primary_identity_pub', attrs: {}, content: primaryIdentity.public },
      {
        tag: 'link_code_pairing_wrapped_primary_ephemeral_pub',
        attrs: {},
        content: wrapped
      }
    ]
  }

  const { node, advSecretKey } = await buildCompanionFinish(
    stanza,
    creds,
    creds.me.id,
    'msg-1'
  )

  check('finish stanza is an iq set', node.tag === 'iq' && node.attrs.type === 'set')
  const reg = node.content[0] as any
  check('stage is companion_finish', reg.attrs.stage === 'companion_finish')
  check('jid carried through', reg.attrs.jid === creds.me.id)

  const bundle = reg.content.find((c: any) => c.tag === 'link_code_pairing_wrapped_key_bundle')!.content as Buffer
  const identityPub = reg.content.find((c: any) => c.tag === 'companion_identity_public')!.content as Buffer
  const ref = reg.content.find((c: any) => c.tag === 'link_code_pairing_ref')!.content as Buffer
  check('ref echoed', ref.toString() === 'REF-XYZ')
  check('companion identity is our signing key', Buffer.compare(identityPub, creds.signedIdentityKey.public) === 0)

  // Server recovers the shared key from the companion's pairing ephemeral key.
  const companionSharedKey = Curve.sharedKey(
    primaryEphemeral.private,
    creds.pairingEphemeralKeyPair.public
  )

  const bSalt = bundle.subarray(0, 32)
  const bIv = bundle.subarray(32, 44)
  const bCipher = bundle.subarray(44)
  const bundleKey = hkdf(companionSharedKey, 32, {
    salt: bSalt,
    info: 'link_code_pairing_key_bundle_encryption_key'
  })
  const plain = aesDecryptGCM(bCipher, bundleKey, bIv, Buffer.alloc(0))

  const companionIdentity = plain.subarray(0, 32)
  const primaryIdentityEcho = plain.subarray(32, 64)
  const random = plain.subarray(64, 96)

  check('bundle carries companion identity', Buffer.compare(companionIdentity, creds.signedIdentityKey.public) === 0)
  check('bundle carries primary identity', Buffer.compare(primaryIdentityEcho, primaryIdentity.public) === 0)

  // Server recomputes the adv secret and it must match the client's.
  const identitySharedKey = Curve.sharedKey(primaryIdentity.private, companionIdentity)
  const expectedAdv = Buffer.from(
    hkdf(Buffer.concat([companionSharedKey, identitySharedKey, random]), 32, { info: 'adv_secret' })
  ).toString('base64')

  check('adv secret matches server derivation', advSecretKey === expectedAdv)

  console.log(`\n${pass}/${total} pairing checks passed`)
  if (pass !== total) process.exitCode = 1
}

run()
