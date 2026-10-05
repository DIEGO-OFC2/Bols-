export interface WhisperMessage {
    ephemeralKey?: Buffer;
    counter?: number;
    previousCounter?: number;
    ciphertext?: Buffer;
}
export interface PreKeyWhisperMessage {
    preKeyId?: number;
    baseKey?: Buffer;
    identityKey?: Buffer;
    message?: Buffer;
    registrationId?: number;
    signedPreKeyId?: number;
}
export declare const encodeWhisperMessage: (msg: WhisperMessage) => Buffer;
export declare const decodeWhisperMessage: (buf: Uint8Array) => WhisperMessage;
export declare const encodePreKeyWhisperMessage: (msg: PreKeyWhisperMessage) => Buffer;
export declare const decodePreKeyWhisperMessage: (buf: Uint8Array) => PreKeyWhisperMessage;
//# sourceMappingURL=protobuf.d.ts.map