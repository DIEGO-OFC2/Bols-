/**
 * Protobuf codec for the Signal "WhisperText" wire messages, matching the
 * schema WhatsApp's libsignal uses. Hand-rolled to avoid a protobuf runtime.
 */
import { ProtoReader, ProtoWriter } from '../proto/writer.js'

export interface WhisperMessage {
  ephemeralKey?: Buffer
  counter?: number
  previousCounter?: number
  ciphertext?: Buffer
}

export interface PreKeyWhisperMessage {
  preKeyId?: number
  baseKey?: Buffer
  identityKey?: Buffer
  message?: Buffer
  registrationId?: number
  signedPreKeyId?: number
}

export const encodeWhisperMessage = (msg: WhisperMessage): Buffer =>
  new ProtoWriter()
    .bytes(1, msg.ephemeralKey!)
    .uint32(2, msg.counter ?? 0)
    .uint32(3, msg.previousCounter ?? 0)
    .bytes(4, msg.ciphertext!)
    .finish()

export const decodeWhisperMessage = (buf: Uint8Array): WhisperMessage => {
  const reader = new ProtoReader(Buffer.from(buf))
  const out: WhisperMessage = {}
  for (let f = reader.next(); f; f = reader.next()) {
    if (f.field === 1) out.ephemeralKey = f.value as Buffer
    else if (f.field === 2) out.counter = Number(f.value)
    else if (f.field === 3) out.previousCounter = Number(f.value)
    else if (f.field === 4) out.ciphertext = f.value as Buffer
  }
  return out
}

export const encodePreKeyWhisperMessage = (msg: PreKeyWhisperMessage): Buffer => {
  const w = new ProtoWriter()
  if (msg.preKeyId !== undefined) w.uint32(1, msg.preKeyId)
  w.bytes(2, msg.baseKey!)
  w.bytes(3, msg.identityKey!)
  w.bytes(4, msg.message!)
  w.uint32(5, msg.registrationId ?? 0)
  w.uint32(6, msg.signedPreKeyId ?? 0)
  return w.finish()
}

export const decodePreKeyWhisperMessage = (buf: Uint8Array): PreKeyWhisperMessage => {
  const reader = new ProtoReader(Buffer.from(buf))
  const out: PreKeyWhisperMessage = {}
  for (let f = reader.next(); f; f = reader.next()) {
    if (f.field === 1) out.preKeyId = Number(f.value)
    else if (f.field === 2) out.baseKey = f.value as Buffer
    else if (f.field === 3) out.identityKey = f.value as Buffer
    else if (f.field === 4) out.message = f.value as Buffer
    else if (f.field === 5) out.registrationId = Number(f.value)
    else if (f.field === 6) out.signedPreKeyId = Number(f.value)
  }
  return out
}
