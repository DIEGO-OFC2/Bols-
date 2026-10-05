import { type BinaryNode } from './types.js';
/**
 * A small growable byte sink. Writing straight into one contiguous buffer
 * avoids the per-byte `Array.push` cost and the final `Buffer.from(number[])`
 * copy that a naive encoder pays.
 */
declare class ByteWriter {
    private buf;
    private len;
    constructor(initial?: number);
    private ensure;
    byte(v: number): void;
    bytes(src: Uint8Array): void;
    /** big-endian fixed-width integer (n bytes) */
    intBE(value: number, n: number): void;
    /** UTF-8 string */
    str(s: string): void;
    finish(): Buffer;
}
declare const CROCKFORD = "123456789ABCDEFGHJKLMNPQRSTVWXYZ";
declare const writeByteLength: (w: ByteWriter, length: number) => void;
declare const writeString: (w: ByteWriter, s: string | undefined) => void;
declare const writeListStart: (w: ByteWriter, size: number) => void;
declare const encodeInner: (w: ByteWriter, node: BinaryNode) => void;
export declare const encodeBinaryNode: (node: BinaryNode) => Buffer;
/** Encode a node straight into a caller-owned writer (used inside the frame writer). */
export declare const encodeBinaryNodeTo: (w: ByteWriter, node: BinaryNode) => void;
export { ByteWriter, writeByteLength, writeString, writeListStart, encodeInner };
export { CROCKFORD };
//# sourceMappingURL=encode.d.ts.map