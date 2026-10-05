import { ProtoReader, ProtoWriter } from './writer.js'

export interface HandshakeMessage {
  clientHello?: {
    ephemeral?: Uint8Array
    static?: Uint8Array
    payload?: Uint8Array
    useExtended?: boolean
    extendedCiphertext?: Uint8Array
  }
  serverHello?: {
    ephemeral?: Uint8Array
    static?: Uint8Array
    payload?: Uint8Array
    extendedStatic?: Uint8Array
  }
  clientFinish?: {
    static?: Uint8Array
    payload?: Uint8Array
    extendedCiphertext?: Uint8Array
  }
}

const encodeClientHello = (h: NonNullable<HandshakeMessage['clientHello']>): ProtoWriter => {
  const w = new ProtoWriter()
  if (h.ephemeral) w.bytes(1, h.ephemeral)
  if (h.static) w.bytes(2, h.static)
  if (h.payload) w.bytes(3, h.payload)
  if (h.useExtended !== undefined) w.bool(4, h.useExtended)
  if (h.extendedCiphertext) w.bytes(5, h.extendedCiphertext)
  return w
}

const encodeServerHello = (h: NonNullable<HandshakeMessage['serverHello']>): ProtoWriter => {
  const w = new ProtoWriter()
  if (h.ephemeral) w.bytes(1, h.ephemeral)
  if (h.static) w.bytes(2, h.static)
  if (h.payload) w.bytes(3, h.payload)
  if (h.extendedStatic) w.bytes(4, h.extendedStatic)
  return w
}

const encodeClientFinish = (h: NonNullable<HandshakeMessage['clientFinish']>): ProtoWriter => {
  const w = new ProtoWriter()
  if (h.static) w.bytes(1, h.static)
  if (h.payload) w.bytes(2, h.payload)
  if (h.extendedCiphertext) w.bytes(3, h.extendedCiphertext)
  return w
}

export const encodeHandshakeMessage = (msg: HandshakeMessage): Buffer => {
  const w = new ProtoWriter()
  if (msg.clientHello) w.message(2, encodeClientHello(msg.clientHello))
  if (msg.serverHello) w.message(3, encodeServerHello(msg.serverHello))
  if (msg.clientFinish) w.message(4, encodeClientFinish(msg.clientFinish))
  return w.finish()
}

const decodeField = (buf: Buffer, fieldNo: number): Buffer | undefined => {
  const r = new ProtoReader(buf)
  let e
  while ((e = r.next())) {
    if (e.field === fieldNo && e.wireType === 2) return e.value as Buffer
    if (e.field === fieldNo && e.wireType === 0) return Buffer.from([Number(e.value)])
  }
  return undefined
}

export const decodeHandshakeMessage = (buf: Uint8Array): HandshakeMessage => {
  const r = new ProtoReader(Buffer.from(buf))
  const out: HandshakeMessage = {}
  let e
  while ((e = r.next())) {
    const sub = e.value as Buffer
    if (e.field === 2) {
      out.clientHello = {
        ephemeral: decodeField(sub, 1),
        static: decodeField(sub, 2),
        payload: decodeField(sub, 3),
        useExtended: decodeField(sub, 4)?.readUInt8(0) === 1,
        extendedCiphertext: decodeField(sub, 5)
      }
    } else if (e.field === 3) {
      out.serverHello = {
        ephemeral: decodeField(sub, 1),
        static: decodeField(sub, 2),
        payload: decodeField(sub, 3),
        extendedStatic: decodeField(sub, 4)
      }
    } else if (e.field === 4) {
      out.clientFinish = {
        static: decodeField(sub, 1),
        payload: decodeField(sub, 2),
        extendedCiphertext: decodeField(sub, 3)
      }
    }
  }
  return out
}
