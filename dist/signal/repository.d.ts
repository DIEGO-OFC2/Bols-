import type { AuthenticationState } from '../utils/auth-utils.js';
import { type PreKeyBundle } from './session.js';
import { LIDMappingStore } from './lid-mapping.js';
export interface EncryptResult {
    type: 'msg' | 'pkmsg';
    ciphertext: Buffer;
}
export declare class SignalRepository {
    private readonly auth;
    private readonly logger;
    readonly lidMapping: LIDMappingStore;
    private readonly storage;
    private readonly groupStore;
    constructor(auth: AuthenticationState, logger: {
        debug: (o: unknown, m: string) => void;
        warn: (o: unknown, m: string) => void;
    });
    /** Map a PN signal address to its LID equivalent when a mapping exists. */
    private resolveWireId;
    private address;
    hasSession(jid: string): Promise<boolean>;
    injectE2ESession(jid: string, bundle: PreKeyBundle): Promise<void>;
    encryptMessage(jid: string, data: Uint8Array): Promise<EncryptResult>;
    decryptMessage(jid: string, type: 'msg' | 'pkmsg', ciphertext: Uint8Array): Promise<Buffer>;
    validateSession(jid: string): Promise<{
        exists: boolean;
    }>;
    hasSenderKey(group: string, senderId: string, senderDevice: number): Promise<boolean>;
    createSenderKeyDistribution(group: string, senderId: string, senderDevice: number): Promise<Buffer>;
    processSenderKeyDistribution(group: string, authorJid: string, serialized: Uint8Array): Promise<void>;
    encryptGroupMessage(group: string, senderId: string, senderDevice: number, data: Uint8Array): Promise<Buffer>;
    decryptGroupMessage(group: string, authorJid: string, data: Uint8Array): Promise<Buffer>;
}
//# sourceMappingURL=repository.d.ts.map