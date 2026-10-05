import { asBuffer } from '../crypto/index.js';
import { type PreKeyWhisperMessage } from './protobuf.js';
/** Fixed one-byte HMAC messages used to step the chain without per-call allocation. */
export declare const CHAIN_MSG: Buffer<ArrayBuffer>;
export declare const CHAIN_NEXT: Buffer<ArrayBuffer>;
export { asBuffer };
export interface SignalKeyPair {
    privKey: Buffer;
    pubKey: Buffer;
}
declare const hmac: (key: Buffer, data: Buffer) => Buffer;
/** libsignal's fixed 3-chunk HKDF variant (returns N 32-byte outputs). */
export declare const deriveSecrets: (input: Buffer, salt: Buffer, info: Buffer, chunks?: number) => Buffer[];
export declare const verifyMAC: (data: Buffer, key: Buffer, mac: Buffer, length: number) => void;
interface Chain {
    messageKeys: Record<number, Buffer>;
    chainKey: {
        counter: number;
        key?: Buffer;
    };
    chainType: number;
}
interface SessionEntry {
    registrationId: number;
    currentRatchet: {
        ephemeralKeyPair: SignalKeyPair;
        lastRemoteEphemeralKey: Buffer;
        previousCounter: number;
        rootKey: Buffer;
    };
    indexInfo: {
        created: number;
        used: number;
        remoteIdentityKey: Buffer;
        baseKey: Buffer;
        baseKeyType: number;
        closed: number;
    };
    pendingPreKey?: {
        signedKeyId: number;
        baseKey: Buffer;
        preKeyId?: number;
    };
    chains: Map<string, Chain>;
}
/** Serialized form is JSON with base64 buffers, matching libsignal's shape. */
export declare class SessionRecord {
    sessions: Record<string, SessionEntry>;
    version: string;
    static deserialize(data: {
        _sessions?: Record<string, any>;
    }): SessionRecord;
    serialize(): object;
    getOpenSession(): SessionEntry | undefined;
    getSession(baseKey: Buffer): SessionEntry | undefined;
    setSession(session: SessionEntry): void;
    getSessions(): SessionEntry[];
    closeSession(session: SessionEntry): void;
    isClosed(session: SessionEntry): boolean;
    removeOldSessions(): void;
}
export interface SignalStorage {
    loadSession(id: string): Promise<SessionRecord | null>;
    storeSession(id: string, record: SessionRecord): Promise<void>;
    isTrustedIdentity(id: string, identityKey: Uint8Array): Promise<boolean>;
    loadPreKey(id: number): Promise<SignalKeyPair | undefined>;
    removePreKey(id: number): Promise<void>;
    loadSignedPreKey(): Promise<SignalKeyPair>;
    getOurRegistrationId(): number;
    getOurIdentity(): SignalKeyPair;
}
export interface PreKeyBundle {
    registrationId: number;
    identityKey: Uint8Array;
    signedPreKey: {
        keyId: number;
        publicKey: Uint8Array;
        signature: Uint8Array;
    };
    preKey?: {
        keyId: number;
        publicKey: Uint8Array;
    };
}
export declare class SessionBuilder {
    private readonly storage;
    private readonly addr;
    constructor(storage: SignalStorage, addr: string);
    initOutgoing(device: PreKeyBundle): Promise<void>;
    initIncoming(record: SessionRecord, message: PreKeyWhisperMessage): Promise<number | undefined>;
    private initSession;
    private calculateSendingRatchet;
}
export interface CipherText {
    type: number;
    body: Buffer;
    registrationId: number;
}
export declare class SessionCipher {
    private readonly storage;
    private readonly addr;
    constructor(storage: SignalStorage, addr: string);
    encrypt(data: Buffer): Promise<CipherText>;
    decryptWhisperMessage(data: Buffer): Promise<Buffer>;
    decryptPreKeyWhisperMessage(data: Buffer): Promise<Buffer>;
    private doDecrypt;
    private fillMessageKeys;
    private maybeStepRatchet;
    private calculateRatchet;
    private storeRecord;
}
export { hmac };
//# sourceMappingURL=session.d.ts.map