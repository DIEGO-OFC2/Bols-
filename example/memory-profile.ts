/**
 * Memory profile: exercises the hot paths (message encode/decode, Signal
 * encrypt/decrypt with session persistence, media encryption) and reports how
 * the heap behaves over many iterations. A frugal client should reach a
 * plateau rather than growing linearly.
 *
 * Run with:  npm run profile
 */
import { Curve, generateSignalPubKey } from '../src/crypto/index.js'
import { initAuthCreds, makeInMemoryKeyStore, type AuthenticationState } from '../src/utils/auth-utils.js'
import { SignalRepository } from '../src/signal/repository.js'
import { encodeMessage, decodeMessage } from '../src/proto/message.js'
import { encryptMedia, decryptMedia } from '../src/media/index.js'
import type { KeyPair } from '../src/crypto/index.js'

const fmt = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`

const makeState = (): AuthenticationState => ({ creds: initAuthCreds(), keys: makeInMemoryKeyStore() })

const run = async () => {
  const alice = makeState()
  const bob = makeState()
  alice.creds.me = { id: '15550000001@s.whatsapp.net' }
  bob.creds.me = { id: '15550000002@s.whatsapp.net' }

  const bobPreKey: KeyPair = Curve.generateKeyPair()
  await bob.keys.set({ 'pre-key': { 1: bobPreKey as any } })

  const aliceRepo = new SignalRepository(alice, { debug: () => {}, warn: () => {} })
  const bobRepo = new SignalRepository(bob, { debug: () => {}, warn: () => {} })

  await aliceRepo.injectE2ESession('15550000002@s.whatsapp.net', {
    registrationId: bob.creds.registrationId,
    identityKey: generateSignalPubKey(bob.creds.signedIdentityKey.public),
    signedPreKey: {
      keyId: bob.creds.signedPreKey.keyId,
      publicKey: generateSignalPubKey(bob.creds.signedPreKey.keyPair.public),
      signature: bob.creds.signedPreKey.signature
    },
    preKey: { keyId: 1, publicKey: generateSignalPubKey(bobPreKey.public) }
  })

  const payload = encodeMessage({ conversation: 'x'.repeat(256) })
  const media = Buffer.alloc(256 * 1024, 7)

  const ITER = 20_000
  const snapshots: number[] = []
  for (let i = 0; i < ITER; i++) {
    const enc = await aliceRepo.encryptMessage('15550000002@s.whatsapp.net', payload)
    const dec = await bobRepo.decryptMessage('15550000001@s.whatsapp.net', enc.type, enc.ciphertext)
    decodeMessage(dec)

    if (i % 1000 === 0) {
      const enc2 = await bobRepo.encryptMessage('15550000001@s.whatsapp.net', payload)
      await aliceRepo.decryptMessage('15550000002@s.whatsapp.net', enc2.type, enc2.ciphertext)
    }

    if (i > 0 && i % 5000 === 0) {
      if (global.gc) global.gc()
      const m = process.memoryUsage()
      snapshots.push(m.heapUsed)
      console.log(`iter ${i.toString().padStart(6)}  rss=${fmt(m.rss)}  heapUsed=${fmt(m.heapUsed)}`)
    }
  }

  // Media encryption is buffer-heavy; measure it separately.
  const before = process.memoryUsage().heapUsed
  for (let i = 0; i < 50; i++) {
    const e = encryptMedia(media, 'image')
    decryptMedia(e.encrypted, e.mediaKey, 'image')
  }
  if (global.gc) global.gc()
  const after = process.memoryUsage().heapUsed
  console.log(`media x50 leaked ~${fmt(after - before)}`)

  const first = snapshots[0]!
  const last = snapshots[snapshots.length - 1]!
  const growth = last - first
  console.log(`\nheap growth over ${snapshots.length} snapshots: ${fmt(growth)}`)
  console.log(growth < 8 * 1024 * 1024 ? 'PLATEAU_OK (steady state)' : 'WARNING: heap grew')
}

run().catch(e => {
  console.error(e)
  process.exitCode = 1
})
