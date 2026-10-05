import { ProtoReader, ProtoWriter } from './writer.js'

export enum ADVEncryptionType {
  E2EE = 0,
  HOSTED = 1
}

// Signature domain-separation prefixes (see the reference)
// WA_ADV_DEVICE_SIG_PREFIX = [6,1], hosted account/device likewise.
const ACCOUNT_SIG_PREFIX = Buffer.from([6, 0])
const HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5])

export interface ADVDeviceIdentity {
  rawId?: number
  timestamp?: bigint
  keyIndex?: number
  accountType?: ADVEncryptionType
  deviceType?: ADVEncryptionType
}

export interface ADVSignedDeviceIdentity {
  details?: Buffer
  accountSignatureKey?: Buffer
  accountSignature?: Buffer
  deviceSignature?: Buffer
}

export interface ADVSignedDeviceIdentityHMAC {
  details?: Buffer
  hmac?: Buffer
  accountType?: ADVEncryptionType
}

const decodeMessageField = (buf: Buffer, field: number): Buffer | undefined => {
  const r = new ProtoReader(buf)
  let e
  while ((e = r.next())) if (e.field === field && e.wireType === 2) return e.value as Buffer
  return undefined
}

const decodeVarintField = (buf: Buffer, field: number): bigint | undefined => {
  const r = new ProtoReader(buf)
  let e
  while ((e = r.next())) if (e.field === field && e.wireType === 0) return e.value as bigint
  return undefined
}

export const decodeADVDeviceIdentity = (buf: Uint8Array): ADVDeviceIdentity => {
  const b = Buffer.from(buf)
  return {
    rawId: Number(decodeVarintField(b, 1) ?? 0),
    timestamp: decodeVarintField(b, 2) ?? 0n,
    keyIndex: Number(decodeVarintField(b, 3) ?? 0),
    accountType: (Number(decodeVarintField(b, 4) ?? 0) as ADVEncryptionType),
    deviceType: (Number(decodeVarintField(b, 5) ?? 0) as ADVEncryptionType)
  }
}

export const decodeADVSignedDeviceIdentity = (buf: Uint8Array): ADVSignedDeviceIdentity => {
  const b = Buffer.from(buf)
  return {
    details: decodeMessageField(b, 1),
    accountSignatureKey: decodeMessageField(b, 2),
    accountSignature: decodeMessageField(b, 3),
    deviceSignature: decodeMessageField(b, 4)
  }
}

export const decodeADVSignedDeviceIdentityHMAC = (buf: Uint8Array): ADVSignedDeviceIdentityHMAC => {
  const b = Buffer.from(buf)
  return {
    details: decodeMessageField(b, 1),
    hmac: decodeMessageField(b, 2),
    accountType: Number(decodeVarintField(b, 3) ?? 0) as ADVEncryptionType
  }
}

/** Encode ADVSignedDeviceIdentity, optionally dropping the account signature key. */
export const encodeADVSignedDeviceIdentity = (
  account: ADVSignedDeviceIdentity,
  includeSignatureKey: boolean
): Buffer => {
  const w = new ProtoWriter()
  if (account.details) w.bytes(1, account.details)
  if (includeSignatureKey && account.accountSignatureKey?.length) w.bytes(2, account.accountSignatureKey)
  if (account.accountSignature) w.bytes(3, account.accountSignature)
  if (account.deviceSignature) w.bytes(4, account.deviceSignature)
  return w.finish()
}

export const accountSignaturePrefix = (type: ADVEncryptionType | undefined): Buffer =>
  type === ADVEncryptionType.HOSTED ? HOSTED_ACCOUNT_SIG_PREFIX : ACCOUNT_SIG_PREFIX
