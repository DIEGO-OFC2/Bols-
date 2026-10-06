/**
 * A peer's Signal session to us must survive a change of addressing form.
 * WhatsApp may send one message PN-addressed and the next LID-addressed (or
 * vice versa). If the two forms key different session records, the message
 * fails to decrypt and the client silently drops it — the "active but does not
 * respond" symptom. Guards `SignalRepository` addressing consistency.
 */
import { Curve, generateSignalPubKey } from '../src/crypto/index.js'
import { SignalRepository } from '../src/signal/repository.js'
import { initAuthState, type AuthenticationState } from '../src/utils/auth-utils.js'
import type { KeyPair } from '../src/crypto/index.js'

let total = 0
let pass = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const BOB = '15550000001'
const BOB_JID = `${BOB}@s.whatsapp.net`
const BOB_LID = '200000000000000'
const BOB_LID_JID = `${BOB_LID}@lid`

const repoFor = (state: AuthenticationState) => new SignalRepository(state, { debug: () => {}, warn: () => {} })

const bundleFor = async (state: AuthenticationState, id: number) => {
  const preKey: KeyPair = Curve.generateKeyPair()
  await state.keys.set({ 'pre-key': { [id]: preKey as any } })
  return {
    registrationId: state.creds.registrationId,
    identityKey: generateSignalPubKey(state.creds.signedIdentityKey.public),
    signedPreKey: {
      keyId: state.creds.signedPreKey.keyId,
      publicKey: generateSignalPubKey(state.creds.signedPreKey.keyPair.public),
      signature: state.creds.signedPreKey.signature
    },
    preKey: { keyId: id, publicKey: generateSignalPubKey(preKey.public) }
  }
}

const run = async () => {
  const meState = initAuthState()
  meState.creds.me = { id: '15559999999:0@s.whatsapp.net', name: 'me', lid: '100000000000000@lid' }
  const repo = repoFor(meState)

  const bobState = initAuthState()
  bobState.creds.me = { id: `${BOB}:0@s.whatsapp.net` }
  const bundle = await bundleFor(bobState, 7)

  // An outgoing session to the peer was created while we addressed it by PN.
  await repo.injectE2ESession(BOB_JID, bundle)
  check('session visible under PN', await repo.hasSession(BOB_JID))

  // The server now tells us the peer's LID and may address it that way.
  await repo.lidMapping.storeLIDPNMappings([{ lid: BOB_LID_JID, pn: BOB_JID }])
  check('session still visible under PN after mapping', await repo.hasSession(BOB_JID))
  check('session visible under LID after mapping', await repo.hasSession(BOB_LID_JID))

  // The inverse: a session first created against the LID must be reachable by PN.
  const meState2 = initAuthState()
  meState2.creds.me = { id: '15559999999:0@s.whatsapp.net', name: 'me', lid: '100000000000000@lid' }
  const repo2 = repoFor(meState2)
  await repo2.lidMapping.storeLIDPNMappings([{ lid: BOB_LID_JID, pn: BOB_JID }])
  await repo2.injectE2ESession(BOB_LID_JID, bundle)
  check('LID-created session visible under LID', await repo2.hasSession(BOB_LID_JID))
  check('LID-created session visible under PN', await repo2.hasSession(BOB_JID))

  console.log(`\n${pass}/${total} session addressing checks passed`)
  if (pass !== total) process.exitCode = 1
}

run().catch(e => {
  console.error(e)
  process.exitCode = 1
})
