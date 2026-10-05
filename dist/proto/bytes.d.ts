/**
 * Fast protobuf wire primitives.
 *
 * The generic reader/writer in `writer.ts` allocates a `Buffer` per varint byte
 * and copies every length-delimited field, which is slow on the message hot
 * path. These primitives keep a single growable buffer for writing and read
 * varints as numbers (falling back to BigInt only past 2^32), and they hand
 * back `subarray` views instead of copies when decoding.
 */
declare const WIRE_VARINT = 0;
declare const WIRE_64BIT = 1;
declare const WIRE_BYTES = 2;
declare const WIRE_32BIT = 5;
export declare class ByteWriter {
    private buf;
    private len;
    constructor(initial?: number);
    private ensure;
    /** Unsigned varint; `value` is treated modulo 2^32 (protobuf int32/uint32). */
    varint(value: number): this;
    private varint64;
    private tag;
    private raw;
    uint32(field: number, value: number | undefined | null): this;
    uint64(field: number, value: number | bigint | undefined | null): this;
    int32(field: number, value: number | undefined | null): this;
    bool(field: number, value: boolean | undefined | null): this;
    sfixed32(field: number, value: number | undefined | null): this;
    /** Length-delimited bytes. */
    bytes(field: number, value: Uint8Array | undefined | null): this;
    string(field: number, value: string | undefined | null): this;
    /** Nested message; the writer is consumed. */
    message(field: number, value: ByteWriter | undefined | null): this;
    repeatedInt32(field: number, values: number[] | undefined | null): this;
    get length(): number;
    /** Returns a copy of the written bytes. */
    finish(): Buffer;
    /** Zero-copy view of the written bytes (valid until the next write). */
    view(): Buffer;
    /** Reuse this writer for another message. */
    reset(): void;
}
export declare const acquireWriter: () => ByteWriter;
export declare const releaseWriter: (w: ByteWriter) => void;
export declare class ByteReader {
    private readonly buf;
    pos: number;
    constructor(buf: Uint8Array, start?: number);
    get done(): boolean;
    /** Unsigned varint, exact for values < 2^32 (the only ones on our paths). */
    varint(): number;
    /** Reads a field key and returns `(field << 3) | wireType`. */
    key(): number;
    /** Length-delimited bytes as a view into the backing buffer. */
    bytes(): Uint8Array;
    string(): string;
    uint(): number;
    /** Skips a field's value given its wire type. */
    skip(wireType: number): void;
}
export { WIRE_VARINT, WIRE_64BIT, WIRE_BYTES, WIRE_32BIT };
//# sourceMappingURL=bytes.d.ts.map