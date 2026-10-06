/** Big-endian integer, default 4 bytes (matching the reference). */
export declare const encodeBigEndian: (value: number, bytes?: number) => Uint8Array;
/** 14-bit registration id. */
export declare const generateRegistrationId: () => number;
export declare const randomBase64: (bytes: number) => string;
export declare const unixTimestampSeconds: (date?: Date) => number;
export declare const delay: (ms: number) => Promise<void>;
/**
 * PKCS#7-style padding with a random length 1..16, matching WhatsApp clients:
 * the last byte is the pad length and is repeated `padLength` times. Applied to
 * the *outer* protobuf before Signal encryption and stripped after decryption.
 */
export declare const writeRandomPadMax16: (msg: Uint8Array) => Buffer;
/**
 * Strip the random 1..16 byte padding a peer (or we, on the device-sent copy)
 * appended before encrypting. Real WhatsApp clients always pad, so a plaintext
 * that is not unpadded before protobuf decode is silently mangled — the "bot is
 * active but never answers" symptom.
 */
export declare const unpadRandomMax16: (e: Uint8Array) => Buffer;
export declare const toNumber: (value: unknown) => number;
export declare const bytesToCrockford: (buffer: Uint8Array) => string;
//# sourceMappingURL=generics.d.ts.map