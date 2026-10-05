import { type KeyPair, type SignedKeyPair } from '../crypto/index.js';
export interface SignalIdentity {
    identifier: {
        name: string;
        deviceId: number;
    };
    identifierKey: Uint8Array;
}
export interface AuthenticationCreds {
    noiseKey: KeyPair;
    pairingEphemeralKeyPair: KeyPair;
    signedIdentityKey: KeyPair;
    signedPreKey: SignedKeyPair;
    registrationId: number;
    advSecretKey: string;
    nextPreKeyId: number;
    firstUnuploadedPreKeyId: number;
    me?: {
        id: string;
        name?: string;
        lid?: string;
    };
    account?: Record<string, unknown>;
    signalIdentities?: SignalIdentity[];
    platform?: string;
    registered: boolean;
    pairingCode?: string;
    routingInfo?: Buffer;
    lastPropHash?: string;
    additionalData?: Record<string, unknown>;
}
export declare const initAuthCreds: () => AuthenticationCreds;
/**
 * A pluggable key store. Baileys keeps every pre-key in memory; for a frugal
 * client it is far cheaper to persist them and only hold the working set.
 */
export interface SignalKeyStore {
    get(type: 'pre-key' | 'session' | 'sender-key' | 'identity-key' | 'app-state-sync-key', ids: string[]): Promise<Record<string, unknown>>;
    set(data: Record<string, Record<string, unknown> | null>): Promise<void>;
}
/** In-memory store for tests and short-lived sessions. */
export declare const makeInMemoryKeyStore: () => SignalKeyStore;
export interface AuthenticationState {
    creds: AuthenticationCreds;
    keys: SignalKeyStore;
}
export declare const initAuthState: (keys?: SignalKeyStore) => AuthenticationState;
//# sourceMappingURL=auth-utils.d.ts.map