export interface HandshakeMessage {
    clientHello?: {
        ephemeral?: Uint8Array;
        static?: Uint8Array;
        payload?: Uint8Array;
        useExtended?: boolean;
        extendedCiphertext?: Uint8Array;
    };
    serverHello?: {
        ephemeral?: Uint8Array;
        static?: Uint8Array;
        payload?: Uint8Array;
        extendedStatic?: Uint8Array;
    };
    clientFinish?: {
        static?: Uint8Array;
        payload?: Uint8Array;
        extendedCiphertext?: Uint8Array;
    };
}
export declare const encodeHandshakeMessage: (msg: HandshakeMessage) => Buffer;
export declare const decodeHandshakeMessage: (buf: Uint8Array) => HandshakeMessage;
//# sourceMappingURL=handshake.d.ts.map