/** Big-endian integer, default 4 bytes (matching the reference). */
export declare const encodeBigEndian: (value: number, bytes?: number) => Uint8Array;
/** 14-bit registration id. */
export declare const generateRegistrationId: () => number;
export declare const randomBase64: (bytes: number) => string;
export declare const unixTimestampSeconds: (date?: Date) => number;
export declare const delay: (ms: number) => Promise<void>;
export declare const toNumber: (value: unknown) => number;
export declare const bytesToCrockford: (buffer: Uint8Array) => string;
//# sourceMappingURL=generics.d.ts.map