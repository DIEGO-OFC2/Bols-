import { type BinaryNode } from './types.js';
/**
 * If the frame starts with the compression flag, inflate the remainder.
 * Otherwise drop the leading dictionary-version byte.
 */
export declare const maybeDecompress: (frame: Buffer) => Promise<Buffer>;
/** Decode an uncompressed node, dropping the leading flag byte. */
export declare const decodeBinaryNode: (buffer: Buffer) => BinaryNode;
/** Decode a frame, inflating it first when the compression flag is set. */
export declare const decodeBinaryNodeFrame: (buffer: Buffer) => Promise<BinaryNode>;
//# sourceMappingURL=decode.d.ts.map