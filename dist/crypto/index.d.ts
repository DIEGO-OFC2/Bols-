export interface KeyPair {
    private: Uint8Array;
    public: Uint8Array;
}
export interface SignedKeyPair {
    keyPair: KeyPair;
    signature: Uint8Array;
    keyId: number;
}
declare const edwardsPublicFromScalar: (raw: Uint8Array) => Uint8Array;
export declare const Curve: {
    generateKeyPair: () => KeyPair;
    sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array) => Buffer;
    /** XEdDSA signature (compatible with Signal's curve25519 sign). */
    sign: (privateKey: Uint8Array, message: Uint8Array) => Buffer;
    verify: (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;
};
export declare const generateSignalPubKey: (pubKey: Uint8Array) => Uint8Array;
export declare const signedKeyPair: (identityKeyPair: KeyPair, keyId: number) => SignedKeyPair;
/** AES-256-GCM; the auth tag is appended to the ciphertext. */
export declare const aesEncryptGCM: (plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) => Buffer;
/** AES-256-GCM; expects the auth tag appended to the ciphertext. */
export declare const aesDecryptGCM: (ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) => Buffer;
export declare const aesEncryptCTR: (plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array) => Buffer;
export declare const aesDecryptCTR: (ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array) => Buffer;
export declare const aesEncrypt: (plaintext: Uint8Array, key: Uint8Array) => Buffer;
export declare const aesDecrypt: (ciphertext: Uint8Array, key: Uint8Array) => Buffer;
export declare const hmacSign: (buffer: Uint8Array, key: Uint8Array, variant?: "sha256" | "sha512") => Buffer;
export declare const sha256: (buffer: Uint8Array) => Buffer;
/** Zero-copy view when already a Buffer; a wrapping copy otherwise. */
export declare const asBuffer: (u: Uint8Array) => Buffer;
export declare const md5: (buffer: Uint8Array) => Buffer;
/** HKDF-SHA256 (extract then expand), matching the WebCrypto reference semantics. */
export declare const hkdf: (inputKeyMaterial: Uint8Array, expandedLength: number, info?: {
    salt?: Uint8Array;
    info?: string | Uint8Array;
}) => Buffer;
/** PBKDF2-SHA256 with 131072 iterations, used to derive the pairing-code key. */
export declare const derivePairingCodeKey: (pairingCode: string, salt: Uint8Array) => Promise<Buffer>;
export { edwardsPublicFromScalar };
//# sourceMappingURL=index.d.ts.map