/**
 * Minimal, allocation-friendly protobuf wire-format writer and reader.
 * Only the primitives WhatsApp's handshake/profile messages require.
 */

const WIRE_VARINT = 0
const WIRE_64BIT = 1
const WIRE_BYTES = 2
const WIRE_32BIT = 5

export class ProtoWriter {
  private chunks: Buffer[] = []
  private scratch = new Uint8Array(10)

  private varint(value: number | bigint): this {
    let v = typeof value === 'bigint' ? value : BigInt(value >>> 0) | (typeof value === 'bigint' ? 0n : 0n)
    // Preserve sign for negative int32 encoded as 64-bit two's complement.
    if (typeof value === 'number' && value < 0) v = BigInt.asUintN(64, BigInt(Math.trunc(value)))
    else if (typeof value === 'bigint') v = BigInt.asUintN(64, value)
    const s = this.scratch
    let i = 0
    while (v >= 0x80n) {
      s[i++] = Number((v & 0x7fn) | 0x80n)
      v >>= 7n
    }
    s[i++] = Number(v)
    this.chunks.push(Buffer.from(s.subarray(0, i)))
    return this
  }

  private tag(field: number, wireType: number): this {
    return this.varint((field << 3) | wireType)
  }

  uint32(field: number, value: number | undefined): this {
    if (value === undefined || value === null) return this
    return this.tag(field, WIRE_VARINT).varint(value)
  }

  uint64(field: number, value: number | bigint | undefined): this {
    if (value === undefined || value === null) return this
    return this.tag(field, WIRE_VARINT).varint(value)
  }

  int32(field: number, value: number | undefined): this {
    if (value === undefined || value === null) return this
    return this.tag(field, WIRE_VARINT).varint(value < 0 ? BigInt(value) : value)
  }

  bool(field: number, value: boolean | undefined): this {
    if (value === undefined || value === null) return this
    return this.tag(field, WIRE_VARINT).varint(value ? 1 : 0)
  }

  sfixed32(field: number, value: number | undefined): this {
    if (value === undefined || value === null) return this
    const buf = Buffer.allocUnsafe(4)
    buf.writeInt32LE(value | 0)
    return this.tag(field, WIRE_32BIT).raw(buf)
  }

  bytes(field: number, value: Uint8Array): this {
    if (value === undefined || value === null) return this
    const buf = Buffer.from(value)
    return this.tag(field, WIRE_BYTES).varint(buf.length).raw(buf)
  }

  string(field: number, value: string): this {
    if (value === undefined || value === null) return this
    const buf = Buffer.from(value, 'utf-8')
    return this.tag(field, WIRE_BYTES).varint(buf.length).raw(buf)
  }

  message(field: number, value: ProtoWriter): this {
    if (value === undefined || value === null) return this
    return this.bytes(field, value.finish())
  }

  repeatedInt32(field: number, values: number[]): this {
    for (const v of values) this.int32(field, v)
    return this
  }

  private raw(buf: Buffer): this {
    this.chunks.push(buf)
    return this
  }

  finish(): Buffer {
    const out = Buffer.concat(this.chunks)
    this.chunks = []
    return out
  }
}

export class ProtoReader {
  private pos: number

  constructor(
    private readonly buf: Buffer,
    start = 0
  ) {
    this.pos = start
  }

  get done(): boolean {
    return this.pos >= this.buf.length
  }

  private readVarint(): bigint {
    let result = 0n
    let shift = 0n
    while (true) {
      const byte = this.buf[this.pos++]!
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7n
    }
    return result
  }

  next(): { field: number; wireType: number; value: bigint | Buffer } | null {
    if (this.done) return null
    const key = this.readVarint()
    const field = Number(key >> 3n)
    const wireType = Number(key & 7n)
    let value: bigint | Buffer
    if (wireType === WIRE_VARINT) value = this.readVarint()
    else if (wireType === WIRE_BYTES) {
      const len = Number(this.readVarint())
      value = this.buf.subarray(this.pos, this.pos + len)
      this.pos += len
    } else if (wireType === WIRE_32BIT) {
      value = this.buf.subarray(this.pos, this.pos + 4)
      this.pos += 4
    } else if (wireType === WIRE_64BIT) {
      value = this.buf.subarray(this.pos, this.pos + 8)
      this.pos += 8
    } else {
      throw new Error(`unsupported proto wire type ${wireType}`)
    }
    return { field, wireType, value }
  }
}

export const readVarintField = (value: bigint): number => Number(value)
export const readBytesField = (value: Buffer): Buffer => value
