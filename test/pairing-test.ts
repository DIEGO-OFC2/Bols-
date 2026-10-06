import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import {
  Curve,
  aesDecryptGCM,
  aesEncryptCTR,
  derivePairingCodeKey,
  hkdf
} from '../src/crypto/index.js'
import { buildCompanionFinish } from '../src/utils/validate-connection.js'
import { initAuthCreds, initAuthState } from '../src/utils/auth-utils.js'
import { getBinaryNodeChild } from '../src/wabinary/generic-utils.js'
import { WAClient } from '../src/socket/client.js'
import { runServer } from './mock-server.js'

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

  await runE2E()
}

/**
 * Drive the linked-device pairing-code flow end to end: the client requests a
 * code before the socket is open, the mock server answers with a
 * `link_code_companion_reg`, and the client completes `companion_finish`.
 * Reproduces the "noise not initialised" regression when the handshake is not
 * awaited before the request goes out, and the "session never saves" regression
 * when the `primary_hello` notification is not routed.
 */
const runE2E = async () => {
  const ca = Curve.generateKeyPair()
  const ctx: any = { ca }
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>(res => wss.on('listening', () => res()))
  const port = (wss.address() as any).port

  // The primary device's pairing ephemeral key; the client recovers its public
  // half from the wrapped node using the pairing code.
  const primaryEphemeral = Curve.generateKeyPair()
  const primaryIdentity = Curve.generateKeyPair()
  let helloJid: string | undefined
  let finishNode: any
  let ackedNotification = 0
  let clientClosed = false

  const buildWrapped = async (code: string) => {
    const salt = randomBytes(32)
    const iv = randomBytes(16)
    const wrappingKey = await derivePairingCodeKey(code, salt)
    return Buffer.concat([salt, iv, aesEncryptCTR(primaryEphemeral.public, wrappingKey, iv)])
  }

  ctx.onNode = async (node: any, send: (node: any) => void) => {
    if (node.tag === 'ack') {
      if (node.attrs.type === 'link_code_companion_reg') ackedNotification++
      return
    }
    if (node.tag !== 'iq') return
    const reg = getBinaryNodeChild(node, 'link_code_companion_reg')
    if (!reg) return
    if (reg.attrs.stage === 'companion_hello') {
      helloJid = reg.attrs.jid
      const code = client.authState.creds.pairingCode!
      const wrapped = await buildWrapped(code)
      // Server ACKs the hello with the pairing ref.
      send({
        tag: 'iq',
        attrs: { from: '@s.whatsapp.net', type: 'result', id: node.attrs.id },
        content: [
          {
            tag: 'link_code_companion_reg',
            attrs: { stage: 'companion_hello' },
            content: [{ tag: 'link_code_pairing_ref', attrs: {}, content: Buffer.from('REF-E2E') }]
          }
        ]
      })
      // Once the user enters the code the phone sends a `primary_hello`
      // notification carrying the primary identity + wrapped ephemeral key.
      setTimeout(() => {
        // Server quirk: a payload-less companion_reg notification must be acked
        // and ignored, not end the socket.
        send({
          tag: 'notification',
          attrs: { from: '15550000000@s.whatsapp.net', id: 'ntf-0', type: 'link_code_companion_reg' },
          content: [{ tag: 'link_code_companion_reg', attrs: { stage: 'primary_hello' }, content: [] }]
        })
        send({
          tag: 'notification',
          attrs: { from: '15550000000@s.whatsapp.net', id: 'ntf-1', type: 'link_code_companion_reg' },
          content: [
            {
              tag: 'link_code_companion_reg',
              attrs: { stage: 'primary_hello' },
              content: [
                { tag: 'link_code_pairing_ref', attrs: {}, content: Buffer.from('REF-E2E') },
                { tag: 'primary_identity_pub', attrs: {}, content: primaryIdentity.public },
                { tag: 'link_code_pairing_wrapped_primary_ephemeral_pub', attrs: {}, content: wrapped }
              ]
            }
          ]
        })
      }, 40)
    } else if (reg.attrs.stage === 'companion_finish') {
      finishNode = reg
    }
  }
  runServer(wss, ctx)

  const auth = initAuthState()
  const client = new WAClient({
    waWebSocketUrl: `ws://127.0.0.1:${port}`,
    origin: 'https://web.whatsapp.com',
    auth,
    logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    noiseCertPublicKey: ca.public,
    noiseCertSerial: 0
  })
  client.connect()
  client.ev.on('connection.update', (u: any) => { if (u.connection === 'close') clientClosed = true })

  const code = await client.requestPairingCode('15551234567')
  check('pairing code is 8 crockford chars', /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code), code)

  // The server answers asynchronously; wait for companion_finish to land.
  for (let i = 0; i < 150 && !finishNode; i++) await new Promise(r => setTimeout(r, 20))
  check('server received companion_finish', !!finishNode)
  check('both companion_reg notifications acked', ackedNotification === 2, String(ackedNotification))
  check('payload-less notification did not close the socket', !clientClosed)
  check('hello carried the phone jid', helloJid === '15551234567@s.whatsapp.net', String(helloJid))
  check('companion_finish jid matches', finishNode?.attrs.jid === '15551234567@s.whatsapp.net')
  check('creds marked registered', auth.creds.registered === true)

  await client.close()
  wss.close()
  await new Promise(r => setTimeout(r, 50))

  console.log(`\n${pass}/${total} pairing checks passed`)
  if (pass !== total) process.exitCode = 1
}

run()
