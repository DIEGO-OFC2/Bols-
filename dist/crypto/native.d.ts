export interface NativeCrypto {
    hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer;
    sha256(data: Uint8Array): Buffer;
    hmacSha256(key: Uint8Array, message: Uint8Array): Buffer;
}
export declare const nativeCrypto: NativeCrypto | null;
export declare const hasNativeCrypto: boolean;
//# sourceMappingURL=native.d.ts.map