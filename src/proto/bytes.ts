/**
 * Fast protobuf wire primitives.
 *
 * The generic reader/writer in `writer.ts` allocates a `Buffer` per varint byte
 * and copies every length-delimited field, which is slow on the message hot
 * path. These primitives keep a single growable buffer for writing and read
 * varints as numbers (falling back to BigInt only past 2^32), and they hand
 * back `subarray` views instead of copies when decoding.
 */

const WIRE_VARINT = 0
const WIRE_64BIT = 1
const WIRE_BYTES = 2
const WIRE_32BIT = 5

const asBytes = (value: Uint8Array | { type: string; data: number[] | string }): Uint8Array => {
  const v = value as { type?: string; data?: number[] | string }
  if (v.type === 'Buffer') {
    if (Array.isArray(v.data)) return Uint8Array.from(v.data)
    if (typeof v.data === 'string') return Buffer.from(v.data, 'base64')
  }
  return value as Uint8Array
}

export class ByteWriter {
  private buf: Buffer
  private len = 0

  constructor(initial = 256) {
    this.buf = Buffer.allocUnsafe(Math.max(16, initial))
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.len + n) cap *= 2
    const next = Buffer.allocUnsafe(cap)
    this.buf.copy(next, 0, 0, this.len)
    this.buf = next
  }

  /** Unsigned varint; `value` is treated modulo 2^32 (protobuf int32/uint32). */
  varint(value: number): this {
    this.ensure(5)
    let v = value >>> 0
    while (v >= 0x80) {
      this.buf[this.len++] = (v & 0x7f) | 0x80
      v >>>= 7
    }
    this.buf[this.len++] = v
    return this
  }

  private varint64(value: number | bigint): this {
    if (typeof value === 'number') {
      // Fast path for the common case (< 2^32).
      if (Number.isInteger(value) && value >= 0 && value < 0x1_0000_0000) return this.varint(value)
    }
    let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value))
    if (v < 0n) v = BigInt.asUintN(64, v)
    if (v < 0x1_0000_0000n) return this.varint(Number(v))
    this.ensure(10)
    while (v >= 0x80n) {
      this.buf[this.len++] = Number((v & 0x7fn) | 0x80n)
      v >>= 7n
    }
    this.buf[this.len++] = Number(v)
    return this
  }

  private tag(field: number, wireType: number): this {
    return this.varint(((field << 3) | wireType) >>> 0)
  }

  private raw(value: Uint8Array): this {
    this.ensure(value.length)
    if (Buffer.isBuffer(value)) value.copy(this.buf, this.len)
    else this.buf.set(value, this.len)
    this.len += value.length
    return this
  }

  uint32(field: number, value: number | undefined | null): this {
    if (value === undefined || value === null) return this
    return this.tag(field, WIRE_VARINT).varint(value)
  }

  uint64(field: number, value: number | bigint | undefined | null): this {
    if (value === undefined || value === null) return this
    return this.tag(field, WIRE_VARINT).varint64(value)
  }

  int32(field: number, value: number | undefined | null): this {
    if (value === undefined || value === null) return this
    return this.tag(field, WIRE_VARINT).varint(value)
  }

  bool(field: number, value: boolean | undefined | null): this {
    if (value === undefined || value === null) return this
    return this.tag(field, WIRE_VARINT).varint(value ? 1 : 0)
  }

  sfixed32(field: number, value: number | undefined | null): this {
    if (value === undefined || value === null) return this
    this.tag(field, WIRE_32BIT).ensure(4)
    this.buf.writeInt32LE(value | 0, this.len)
    this.len += 4
    return this
  }

  /** Length-delimited bytes. */
  bytes(field: number, value: Uint8Array | undefined | null): this {
    if (value === undefined || value === null) return this
    const bytes = asBytes(value)
    this.tag(field, WIRE_BYTES).varint(bytes.length)
    return this.raw(bytes)
  }

  string(field: number, value: string | undefined | null): this {
    if (value === undefined || value === null) return this
    const n = Buffer.byteLength(value)
    this.tag(field, WIRE_BYTES).varint(n)
    this.ensure(n)
    this.buf.write(value, this.len, n, 'utf8')
    this.len += n
    return this
  }

  /** Nested message; the writer is consumed. */
  message(field: number, value: ByteWriter | undefined | null): this {
    if (value === undefined || value === null) return this
    return this.bytes(field, value.finish())
  }

  repeatedInt32(field: number, values: number[] | undefined | null): this {
    if (values) for (const v of values) this.int32(field, v)
    return this
  }

  get length(): number {
    return this.len
  }

  /** Returns a copy of the written bytes. */
  finish(): Buffer {
    const out = Buffer.allocUnsafe(this.len)
    this.buf.copy(out, 0, 0, this.len)
    return out
  }

  /** Zero-copy view of the written bytes (valid until the next write). */
  view(): Buffer {
    return this.buf.subarray(0, this.len)
  }

  /** Reuse this writer for another message. */
  reset(): void {
    this.len = 0
  }
}

/** Small writer pool so nested-message encoding allocates nothing per message. */
const writerPool: ByteWriter[] = []
export const acquireWriter = (): ByteWriter => writerPool.pop() ?? new ByteWriter(128)
export const releaseWriter = (w: ByteWriter): void => {
  w.reset()
  if (writerPool.length < 16) writerPool.push(w)
}

export class ByteReader {
  pos: number

  constructor(
    private readonly buf: Uint8Array,
    start = 0
  ) {
    this.pos = start
  }

  get done(): boolean {
    return this.pos >= this.buf.length
  }

  /** Unsigned varint, exact for values < 2^32 (the only ones on our paths). */
  varint(): number {
    let b = this.buf[this.pos++]!
    if (b < 0x80) return b
    let result = b & 0x7f
    let shift = 7
    while (shift < 28) {
      b = this.buf[this.pos++]!
      result |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return result >>> 0
      shift += 7
    }
    // Fifth byte may contribute bits above 28. Returns a possibly > 2^32
    // number (exact up to 2^53), which is fine for the fields we decode.
    const fifth = this.buf[this.pos++]!
    return (result >>> 0) + (fifth & 0x7f) * 0x10000000
  }

  /** Reads a field key and returns `(field << 3) | wireType`. */
  key(): number {
    return this.varint()
  }

  /** Length-delimited bytes as a view into the backing buffer. */
  bytes(): Uint8Array {
    const len = this.varint()
    const out = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }

  string(): string {
    const len = this.varint()
    // Buffer.toString avoids an intermediate copy when backed by a Buffer.
    const s = (Buffer.isBuffer(this.buf) ? this.buf.toString('utf8', this.pos, this.pos + len) : Buffer.from(this.buf.subarray(this.pos, this.pos + len)).toString('utf8'))
    this.pos += len
    return s
  }

  uint(): number {
    return this.varint()
  }

  /** Skips a field's value given its wire type. */
  skip(wireType: number): void {
    if (wireType === WIRE_VARINT) this.varint()
    else if (wireType === WIRE_BYTES) this.pos += this.varint()
    else if (wireType === WIRE_32BIT) this.pos += 4
    else if (wireType === WIRE_64BIT) this.pos += 8
    else throw new Error(`unsupported proto wire type ${wireType}`)
  }
}

export { WIRE_VARINT, WIRE_64BIT, WIRE_BYTES, WIRE_32BIT }
