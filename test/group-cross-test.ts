/**
 * Interop test for group (sender-key) messaging against Baileys' WASignalGroup.
 * lightwa and the reference each hold one side of a group sender key and must
 * be able to decrypt the other's sender-key messages.
 */
import {
  buildSenderKeyDistribution,
  decryptGroupMessage,
  encryptGroupMessage,
  processSenderKeyDistribution,
  senderKeyName,
  SenderKeyRecord,
  type SenderKeyStore
} from '../src/signal/group.js'

import { baileysDir, skip } from './reference.js'

if (!baileysDir()) skip('group interop')
const base = baileysDir()!
// Baileys is ESM with an import-only export map, so load its group modules
// through dynamic import rather than require().
const gpath = (f: string) => `${base}/lib/Signal/Group/${f}`
const { SenderKeyName } = await import(gpath('sender-key-name.js'))
const { SenderKeyDistributionMessage } = await import(gpath('sender-key-distribution-message.js'))
const { GroupSessionBuilder } = await import(gpath('group-session-builder.js'))
const { GroupCipher } = await import(gpath('group_cipher.js'))
const { SenderKeyRecord: SenderKeyRecordRef } = await import(gpath('sender-key-record.js'))

let total = 0
let pass = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const lightwaStore = (): SenderKeyStore => {
  const map = new Map<string, SenderKeyRecord>()
  return {
    loadSenderKey: async name => map.get(name) ?? new SenderKeyRecord(),
    storeSenderKey: async (name, rec) => void map.set(name, rec)
  }
}

const refStore = () => {
  const map = new Map<string, any>()
  return {
    loadSenderKey: async (n: any) => map.get(n.toString()) ?? new (SenderKeyRecordRef as any)(),
    storeSenderKey: async (n: any, rec: any) => void map.set(n.toString(), rec)
  }
}

const run = async () => {
  const group = '120363000000000000@g.us'
  const aliceUser = '15550000010'
  const bobUser = '15550000011'
  const aliceName = senderKeyName(group, aliceUser, 0)
  const bobName = senderKeyName(group, bobUser, 0)

  // --- Alice is lightwa, Bob is the reference ---
  const aStore = lightwaStore()
  const bStore = refStore()
  const aliceDist = await buildSenderKeyDistribution(aStore, aliceName)
  check('lightwa builds a sender key distribution message', aliceDist.serialized.length > 0)

  const bobGroupSession = new GroupSessionBuilder(bStore)
  await bobGroupSession.process(new SenderKeyName(group, { id: aliceUser, deviceId: 0 }), new SenderKeyDistributionMessage(null, null, null, null, aliceDist.serialized))
  check('reference accepts lightwa distribution message', true)

  const m1 = await encryptGroupMessage(aStore, aliceName, Buffer.from('group hello 1'))
  const bobCipher = new GroupCipher(bStore, new SenderKeyName(group, { id: aliceUser, deviceId: 0 }))
  const d1 = await bobCipher.decrypt(m1)
  check('reference decrypts lightwa group message', Buffer.from(d1).toString() === 'group hello 1', Buffer.from(d1).toString())

  const m2 = await encryptGroupMessage(aStore, aliceName, Buffer.from('group hello 2'))
  const d2 = await bobCipher.decrypt(m2)
  check('reference decrypts second lightwa group message', Buffer.from(d2).toString() === 'group hello 2', Buffer.from(d2).toString())

  // --- Now Bob (reference) sends to Alice (lightwa) ---
  const bobDist = await new GroupSessionBuilder(bStore).create(new SenderKeyName(group, { id: bobUser, deviceId: 0 }))
  await processSenderKeyDistribution(aStore, bobName, bobDist.serialize())
  const bobSendCipher = new GroupCipher(bStore, new SenderKeyName(group, { id: bobUser, deviceId: 0 }))
  const r1 = await bobSendCipher.encrypt(Buffer.from('ref to lightwa 1'))
  const lightwaDec = await decryptGroupMessage(aStore, bobName, r1)
  check('lightwa decrypts reference group message', lightwaDec.toString() === 'ref to lightwa 1', lightwaDec.toString())

  const r2 = await bobSendCipher.encrypt(Buffer.from('ref to lightwa 2'))
  const lightwaDec2 = await decryptGroupMessage(aStore, bobName, r2)
  check('lightwa decrypts second reference group message', lightwaDec2.toString() === 'ref to lightwa 2', lightwaDec2.toString())

  // --- Out of order within a group chain ---
  const o1 = await encryptGroupMessage(aStore, aliceName, Buffer.from('g-ooo-1'))
  const o2 = await encryptGroupMessage(aStore, aliceName, Buffer.from('g-ooo-2'))
  const od2 = Buffer.from(await bobCipher.decrypt(o2)).toString()
  const od1 = Buffer.from(await bobCipher.decrypt(o1)).toString()
  check('group out-of-order later first', od2 === 'g-ooo-2', od2)
  check('group out-of-order earlier after', od1 === 'g-ooo-1', od1)

  console.log(`\n${pass}/${total} group interop checks passed`)
  if (pass !== total) process.exitCode = 1
}

run().catch(e => {
  console.error(e)
  process.exitCode = 1
})
