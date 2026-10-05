import { ProtoReader, ProtoWriter } from './writer.js'

export interface NoiseCertificateDetails {
  serial?: number
  issuerSerial?: number
  key?: Buffer
  notBefore?: bigint
  notAfter?: bigint
}

export interface NoiseCertificate {
  details?: Buffer
  signature?: Buffer
}

export interface CertChain {
  leaf?: NoiseCertificate
  intermediate?: NoiseCertificate
}

const readMessageAsBytes = (buf: Buffer, field: number): Buffer | undefined => {
  const r = new ProtoReader(buf)
  let e
  while ((e = r.next())) {
    if (e.field === field && e.wireType === 2) return e.value as Buffer
  }
  return undefined
}

export const decodeNoiseCertificate = (buf: Buffer): NoiseCertificate => ({
  details: readMessageAsBytes(buf, 1),
  signature: readMessageAsBytes(buf, 2)
})

export const decodeCertChain = (buf: Uint8Array): CertChain => {
  const r = new ProtoReader(Buffer.from(buf))
  const out: CertChain = {}
  let e
  while ((e = r.next())) {
    if (e.wireType !== 2) continue
    if (e.field === 1) out.leaf = decodeNoiseCertificate(e.value as Buffer)
    else if (e.field === 2) out.intermediate = decodeNoiseCertificate(e.value as Buffer)
  }
  return out
}

export const decodeNoiseCertificateDetails = (buf: Buffer): NoiseCertificateDetails => {
  const r = new ProtoReader(buf)
  const out: NoiseCertificateDetails = {}
  let e
  while ((e = r.next())) {
    const { field, value } = e
    if (field === 1) out.serial = Number(value)
    else if (field === 2) out.issuerSerial = Number(value)
    else if (field === 3) out.key = value as Buffer
    else if (field === 4) out.notBefore = value as bigint
    else if (field === 5) out.notAfter = value as bigint
  }
  return out
}

export const encodeNoiseCertificate = (cert: NoiseCertificate): Buffer => {
  const w = new ProtoWriter()
  if (cert.details) w.bytes(1, cert.details)
  if (cert.signature) w.bytes(2, cert.signature)
  return w.finish()
}

export const encodeNoiseCertificateDetails = (d: NoiseCertificateDetails): Buffer => {
  const w = new ProtoWriter()
  if (d.serial !== undefined) w.uint32(1, d.serial)
  if (d.issuerSerial !== undefined) w.uint32(2, d.issuerSerial)
  if (d.key) w.bytes(3, d.key)
  if (d.notBefore !== undefined) w.uint64(4, d.notBefore)
  if (d.notAfter !== undefined) w.uint64(5, d.notAfter)
  return w.finish()
}

export const encodeCertChain = (chain: CertChain): Buffer => {
  const w = new ProtoWriter()
  if (chain.leaf) w.message(1, new ProtoWriter().bytes(1, chain.leaf.details!).bytes(2, chain.leaf.signature!))
  if (chain.intermediate) {
    w.message(2, new ProtoWriter().bytes(1, chain.intermediate.details!).bytes(2, chain.intermediate.signature!))
  }
  return w.finish()
}
