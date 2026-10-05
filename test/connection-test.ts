// Validate connection node generation against the Baileys reference.
import { encodeClientPayload, encodeDeviceProps } from '../src/proto/client-payload.js'
import { generateLoginNode, generateRegistrationNode } from '../src/utils/validate-connection.js'
import { importBaileys, requireBaileys, baileysDir, skip } from './reference.js'

if (!baileysDir()) skip('connection interop')
const vc: any = await importBaileys('lib/Utils/validate-connection.js')
const au: any = await importBaileys('lib/Utils/auth-utils.js')
if (!vc || !au) skip('connection interop (reference not loadable)')
const refLogin = vc.generateLoginNode
const refReg = vc.generateRegistrationNode
const refInitAuthCreds = au.initAuthCreds
const WAProto = requireBaileys('WAProto/index.js').proto

const config = {
  version: [2, 3000, 1043857760],
  browser: ['Mac OS', 'Chrome', '14.4.1'],
  countryCode: 'US',
  syncFullHistory: true
}

let pass = 0
let total = 0
const check = (label, cond, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

// Login node
const jid = '15551234567:12@s.whatsapp.net'
const mineLogin = encodeClientPayload(generateLoginNode(jid, config))
const refLoginPayload = refLogin(jid, config)
const refLoginBytes = WAProto.ClientPayload.encode(refLoginPayload).finish()
check('login node bytes', Buffer.from(mineLogin).equals(Buffer.from(refLoginBytes)), `\n  mine ${Buffer.from(mineLogin).toString('hex')}\n  ref  ${Buffer.from(refLoginBytes).toString('hex')}`)

// Registration node
const refCreds = refInitAuthCreds()
const myCreds = {
  registrationId: refCreds.registrationId,
  signedPreKey: {
    keyId: refCreds.signedPreKey.keyId,
    keyPair: { private: Buffer.from(refCreds.signedPreKey.keyPair.private), public: Buffer.from(refCreds.signedPreKey.keyPair.public) },
    signature: Buffer.from(refCreds.signedPreKey.signature)
  },
  signedIdentityKey: { private: Buffer.from(refCreds.signedIdentityKey.private), public: Buffer.from(refCreds.signedIdentityKey.public) }
}
const mineReg = encodeClientPayload(generateRegistrationNode(myCreds, config))
const refRegBytes = WAProto.ClientPayload.encode(refReg(refCreds, config)).finish()
check('registration node bytes', Buffer.from(mineReg).equals(Buffer.from(refRegBytes)), `\n  mine ${Buffer.from(mineReg).toString('hex')}\n  ref  ${Buffer.from(refRegBytes).toString('hex')}`)

// DeviceProps portion (decode devicePairingData.deviceProps from both)
const mineDecoded = WAProto.ClientPayload.decode(Buffer.from(mineReg))
const deviceProps = WAProto.DeviceProps.decode(mineDecoded.devicePairingData.deviceProps)
check('historySyncConfig present', deviceProps.historySyncConfig?.storageQuotaMb === 10240)
check('device props platform', deviceProps.platformType === WAProto.DeviceProps.PlatformType.CHROME)

console.log(`\n${pass}/${total} connection checks passed`)
if (pass !== total) process.exitCode = 1
