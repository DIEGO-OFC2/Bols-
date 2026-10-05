/**
 * End-to-end test of SignalRepository: two independent clients (each with its
 * own auth state and key store) exchange pre-key bundles, then hold a 1:1
 * conversation and a group conversation through the repository API only.
 */
import { Curve, generateSignalPubKey, signedKeyPair } from '../src/crypto/index.js'
import { initAuthCreds, makeInMemoryKeyStore, type AuthenticationState } from '../src/utils/auth-utils.js'
import { SignalRepository } from '../src/signal/repository.js'
import type { KeyPair } from '../src/crypto/index.js'

let total = 0
let pass = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const makeState = (): AuthenticationState => ({
  creds: initAuthCreds(),
  keys: makeInMemoryKeyStore()
})

const repoFor = (state: AuthenticationState) =>
  new SignalRepository(state, { debug: () => {}, warn: () => {} })

const run = async () => {
  const aliceState = makeState()
  const bobState = makeState()
  aliceState.creds.me = { id: '15550000001@s.whatsapp.net' }
  bobState.creds.me = { id: '15550000002@s.whatsapp.net' }

  // Give Bob one pre-key and hand its public bundle to Alice.
  const bobPreKey: KeyPair = Curve.generateKeyPair()
  const bobPreKeyId = 1
  await bobState.keys.set({ 'pre-key': { [bobPreKeyId]: bobPreKey as any } })

  const aliceRepo = repoFor(aliceState)
  const bobRepo = repoFor(bobState)

  const aliceJid = '15550000001@s.whatsapp.net'
  const bobJid = '15550000002@s.whatsapp.net'

  await aliceRepo.injectE2ESession(bobJid, {
    registrationId: bobState.creds.registrationId,
    identityKey: generateSignalPubKey(bobState.creds.signedIdentityKey.public),
    signedPreKey: {
      keyId: bobState.creds.signedPreKey.keyId,
      publicKey: generateSignalPubKey(bobState.creds.signedPreKey.keyPair.public),
      signature: bobState.creds.signedPreKey.signature
    },
    preKey: { keyId: bobPreKeyId, publicKey: generateSignalPubKey(bobPreKey.public) }
  })

  check('alice has a session after injection', await aliceRepo.hasSession(bobJid))

  // Alice -> Bob (first message is a pre-key message).
  const m1 = Buffer.from('hello bob')
  const enc1 = await aliceRepo.encryptMessage(bobJid, m1)
  check('first message is a pkmsg', enc1.type === 'pkmsg', enc1.type)
  const dec1 = await bobRepo.decryptMessage(aliceJid, enc1.type, enc1.ciphertext)
  check('bob decrypts alice pkmsg', dec1.equals(m1), dec1.toString())

  // Bob -> Alice (now a whisper message).
  const m2 = Buffer.from('hello alice')
  const enc2 = await bobRepo.encryptMessage(aliceJid, m2)
  check('reply is a msg', enc2.type === 'msg', enc2.type)
  const dec2 = await aliceRepo.decryptMessage(bobJid, enc2.type, enc2.ciphertext)
  check('alice decrypts bob reply', dec2.equals(m2), dec2.toString())

  // Ratchet forward a few messages each way.
  for (let i = 0; i < 5; i++) {
    const a = Buffer.from(`a${i}`)
    const ea = await aliceRepo.encryptMessage(bobJid, a)
    check(`bob decrypts alice #${i}`, (await bobRepo.decryptMessage(aliceJid, ea.type, ea.ciphertext)).equals(a))
    const b = Buffer.from(`b${i}`)
    const eb = await bobRepo.encryptMessage(aliceJid, b)
    check(`alice decrypts bob #${i}`, (await aliceRepo.decryptMessage(bobJid, eb.type, eb.ciphertext)).equals(b))
  }

  // Group conversation via sender keys.
  const group = '120363000000000000@g.us'
  const aliceSender = '15550000001'
  const bobSender = '15550000002'
  const dist = await aliceRepo.createSenderKeyDistribution(group, aliceSender, 0)
  await bobRepo.processSenderKeyDistribution(group, aliceJid, dist)
  const g1 = Buffer.from('group hi')
  const eg1 = await aliceRepo.encryptGroupMessage(group, aliceSender, 0, g1)
  check('bob decrypts group message', (await bobRepo.decryptGroupMessage(group, aliceJid, eg1)).equals(g1))

  // Bob replies in the group.
  const bobDist = await bobRepo.createSenderKeyDistribution(group, bobSender, 0)
  await aliceRepo.processSenderKeyDistribution(group, bobJid, bobDist)
  const g2 = Buffer.from('group reply')
  const eg2 = await bobRepo.encryptGroupMessage(group, bobSender, 0, g2)
  check('alice decrypts group reply', (await aliceRepo.decryptGroupMessage(group, bobJid, eg2)).equals(g2))

  console.log(`\n${pass}/${total} signal repository checks passed`)
  if (pass !== total) process.exitCode = 1
}

run().catch(e => {
  console.error(e)
  process.exitCode = 1
})
