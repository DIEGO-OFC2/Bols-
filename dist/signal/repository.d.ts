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
    /** The Signal storage key for a JID, matching the wire addressing form. */
    private jidToSignalAddress;
    /** Map a PN signal address to its LID equivalent when a mapping exists. */
    private resolveWireId;
    private address;
    /**
     * The counterpart storage key for an address whose record was not found —
     * the LID form of a PN key, or the PN form of a LID key. Uses the stored LID
     * mapping when present and falls back to the stanza-level `@lid` form, so a
     * session survives whichever addressing form the server chose first.
     */
    private altWireId;
    /**
     * Re-key a stored session from one addressing form to another (PN → LID).
     * The server may start addressing a peer by LID after the session was opened
     * against its phone number; without migrating, the LID-addressed message
     * finds no session and is silently dropped. The source key is kept as a
     * fallback because the LID mapping itself is in-memory and lost on restart.
     */
    migrateSession(fromJid: string, toJid: string): Promise<void>;
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