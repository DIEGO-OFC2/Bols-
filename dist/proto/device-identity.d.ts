export declare enum ADVEncryptionType {
    E2EE = 0,
    HOSTED = 1
}
export interface ADVDeviceIdentity {
    rawId?: number;
    timestamp?: bigint;
    keyIndex?: number;
    accountType?: ADVEncryptionType;
    deviceType?: ADVEncryptionType;
}
export interface ADVSignedDeviceIdentity {
    details?: Buffer;
    accountSignatureKey?: Buffer;
    accountSignature?: Buffer;
    deviceSignature?: Buffer;
}
export interface ADVSignedDeviceIdentityHMAC {
    details?: Buffer;
    hmac?: Buffer;
    accountType?: ADVEncryptionType;
}
export declare const decodeADVDeviceIdentity: (buf: Uint8Array) => ADVDeviceIdentity;
export declare const decodeADVSignedDeviceIdentity: (buf: Uint8Array) => ADVSignedDeviceIdentity;
export declare const decodeADVSignedDeviceIdentityHMAC: (buf: Uint8Array) => ADVSignedDeviceIdentityHMAC;
/** Encode ADVSignedDeviceIdentity, optionally dropping the account signature key. */
export declare const encodeADVSignedDeviceIdentity: (account: ADVSignedDeviceIdentity, includeSignatureKey: boolean) => Buffer;
export declare const accountSignaturePrefix: (type: ADVEncryptionType | undefined) => Buffer;
//# sourceMappingURL=device-identity.d.ts.map