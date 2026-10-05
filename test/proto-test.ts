// Validate our hand-written proto codec against the generated WAProto reference.
import { encodeClientPayload, encodeDeviceProps, decodeClientPayload, PlatformType, ConnectReason, Product } from '../src/proto/client-payload.js'
import { encodeHandshakeMessage, decodeHandshakeMessage } from '../src/proto/handshake.js'
import { requireBaileys, baileysDir, skip } from './reference.js'

if (!baileysDir()) skip('proto interop')
const WAProto = requireBaileys('WAProto/index.js').proto

let pass = 0
let total = 0
const check = (label, cond, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

// DeviceProps
const dp = {
  os: 'Baileys',
  version: { primary: 2, secondary: 3000, tertiary: 1043857760 },
  platformType: PlatformType.CHROME,
  requireFullSync: false
}
const mineDp = encodeDeviceProps(dp)
const refDp = WAProto.DeviceProps.encode(WAProto.DeviceProps.create(dp)).finish()
check('DeviceProps bytes', Buffer.from(mineDp).equals(Buffer.from(refDp)), `\n  mine ${Buffer.from(mineDp).toString('hex')}\n  ref  ${Buffer.from(refDp).toString('hex')}`)

// ClientPayload full
const payload = {
  userAgent: {
    platform: 14,
    appVersion: { primary: 2, secondary: 3000, tertiary: 1043857760 },
    releaseChannel: 0,
    deviceType: 2,
    osVersion: '10.15.7',
    localeLanguageIso6391: 'en',
    localeCountryIso31661Alpha2: 'US'
  },
  webInfo: {
    refToken: 'token',
    version: '2.3000.1043857760',
    webdPayload: {
      usesParticipantInKey: true,
      supportsStarredMessages: true,
      supportsDocumentMessages: true,
      supportsUrlMessages: true,
      supportsMediaRetry: true,
      supportsE2EImage: true,
      supportsE2EVideo: true,
      supportsE2EAudio: true,
      supportsE2EDocument: true,
      documentTypes: 'txt',
      features: Buffer.from([1, 2, 3, 4])
    },
    webSubPlatform: 0
  },
  connectType: 1,
  connectReason: ConnectReason.USER_ACTIVATED,
  connectAttemptCount: 1,
  device: 1,
  passive: false,
  pull: true,
  product: Product.WHATSAPP,
  shortConnect: false,
  lc: 5,
  fbAppId: 0n
}
const mineCp = encodeClientPayload(payload)
const refCp = WAProto.ClientPayload.encode(WAProto.ClientPayload.create(payload)).finish()
check('ClientPayload bytes', Buffer.from(mineCp).equals(Buffer.from(refCp)), `\n  mine ${Buffer.from(mineCp).toString('hex')}\n  ref  ${Buffer.from(refCp).toString('hex')}`)

// decode round trip
const decoded = decodeClientPayload(refCp)
check('ClientPayload decode', decoded.userAgent?.platform === 14 && decoded.connectReason === 1 && decoded.pull === true, JSON.stringify(decoded))

// HandshakeMessage clientHello
const hello = {
  clientHello: {
    ephemeral: Buffer.alloc(32, 1),
    static: Buffer.alloc(32, 2),
    payload: Buffer.alloc(64, 3),
    useExtended: false
  }
}
const mineHs = encodeHandshakeMessage(hello)
const refHs = WAProto.HandshakeMessage.encode(WAProto.HandshakeMessage.create(hello)).finish()
check('HandshakeMessage clientHello', Buffer.from(mineHs).equals(Buffer.from(refHs)), `\n  mine ${Buffer.from(mineHs).toString('hex')}\n  ref  ${Buffer.from(refHs).toString('hex')}`)

// serverHello decode
const serverBytes = WAProto.HandshakeMessage.encode(
  WAProto.HandshakeMessage.create({ serverHello: { ephemeral: Buffer.alloc(32, 9), static: Buffer.alloc(32, 8), payload: Buffer.alloc(16, 7) } })
).finish()
const sh = decodeHandshakeMessage(serverBytes)
check('serverHello decode', Buffer.from(sh.serverHello?.ephemeral ?? []).equals(Buffer.alloc(32, 9)) && Buffer.from(sh.serverHello?.payload ?? []).equals(Buffer.alloc(16, 7)))

console.log(`\n${pass}/${total} proto checks passed`)
if (pass !== total) process.exitCode = 1
