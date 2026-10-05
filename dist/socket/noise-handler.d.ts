import type { KeyPair } from '../crypto/index.js';
import type { BinaryNode } from '../wabinary/types.js';
import type { HandshakeMessage } from '../proto/handshake.js';
export declare const NOISE_MODE = "Noise_XX_25519_AESGCM_SHA256\0\0\0\0";
export declare const NOISE_WA_HEADER: Buffer<ArrayBuffer>;
export declare const WA_CERT_SERIAL = 0;
export declare const WA_CERT_PUBLIC_KEY: Buffer<ArrayBuffer>;
type FrameSink = (frame: BinaryNode | Uint8Array) => void;
export interface NoiseHandlerOptions {
    /** Ephemeral key pair, unique per connection. */
    keyPair: KeyPair;
    routingInfo?: Uint8Array;
    logger?: {
        trace: (obj: unknown, msg: string) => void;
    };
    /** Overridable for tests; defaults to the WhatsApp long-term key. */
    certPublicKey?: Uint8Array;
    certSerial?: number;
}
export declare class NoiseHandler {
    private readonly opts;
    private hash;
    private salt;
    private encKey;
    private decKey;
    private counter;
    private sentIntro;
    private transport;
    private isWaitingForTransport;
    private pendingSink;
    private inBytes;
    private readonly introHeader;
    constructor(opts: NoiseHandlerOptions);
    private authenticate;
    private static iv;
    encrypt(plaintext: Uint8Array): Buffer;
    decrypt(ciphertext: Uint8Array): Buffer;
    private localHKDF;
    mixIntoKey(data: Uint8Array): void;
    /** Reset both transport counters, keeping keys (used when the server restarts its IVs). */
    resetTransportCounters(): void;
    /** Derive the transport keys; any buffered frames are flushed to `sink`. */
    finishInit(sink?: FrameSink): Promise<void>;
    /** Validate the server certificate chain (XEdDSA signatures over the leaf). */
    private verifyCertificate;
    /**
     * Process the server hello: mix keys and return the client static-key
     * ciphertext for the client finish message.
     */
    processHandshake(handshake: HandshakeMessage, noiseKey: KeyPair): Buffer;
    /** Prefix the frame with the intro header (once) and a 3-byte length. */
    encodeFrame(data: Uint8Array): Buffer;
    decodeFrame(newData: Uint8Array, onFrame: FrameSink): Promise<void>;
    private processData;
}
export {};
//# sourceMappingURL=noise-handler.d.ts.map