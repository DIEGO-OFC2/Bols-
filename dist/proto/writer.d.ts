/**
 * Minimal, allocation-friendly protobuf wire-format writer and reader.
 * Only the primitives WhatsApp's handshake/profile messages require.
 */
export declare class ProtoWriter {
    private chunks;
    private scratch;
    private varint;
    private tag;
    uint32(field: number, value: number | undefined): this;
    uint64(field: number, value: number | bigint | undefined): this;
    int32(field: number, value: number | undefined): this;
    bool(field: number, value: boolean | undefined): this;
    sfixed32(field: number, value: number | undefined): this;
    bytes(field: number, value: Uint8Array): this;
    string(field: number, value: string): this;
    message(field: number, value: ProtoWriter): this;
    repeatedInt32(field: number, values: number[]): this;
    private raw;
    finish(): Buffer;
}
export declare class ProtoReader {
    private readonly buf;
    private pos;
    constructor(buf: Buffer, start?: number);
    get done(): boolean;
    private readVarint;
    next(): {
        field: number;
        wireType: number;
        value: bigint | Buffer;
    } | null;
}
export declare const readVarintField: (value: bigint) => number;
export declare const readBytesField: (value: Buffer) => Buffer;
//# sourceMappingURL=writer.d.ts.map