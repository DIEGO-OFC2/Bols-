/**
 * The Signal repository ties the session/group crypto to the pluggable key
 * store and exposes the operations the send/receive pipelines need:
 * encrypting to a set of devices, decrypting incoming messages, and injecting
 * freshly fetched pre-key bundles as sessions.
 */
import { generateSignalPubKey } from '../crypto/index.js';
import { jidDecode, jidNormalizedUser, WAJIDDomains } from '../wabinary/jid.js';
import { SessionBuilder, SessionCipher, SessionRecord } from './session.js';
import { decryptGroupMessage, encryptGroupMessage, hasSenderKey, processSenderKeyDistribution as processSkdm, senderKeyName, SenderKeyRecord } from './group.js';
import { LIDMappingStore } from './lid-mapping.js';
export class SignalRepository {
    auth;
    logger;
    lidMapping = new LIDMappingStore();
    storage;
    groupStore;
    constructor(auth, logger) {
        this.auth = auth;
        this.logger = logger;
        const keys = auth.keys;
        const creds = auth.creds;
        const toSignal = (kp) => ({
            privKey: Buffer.from(kp.private),
            pubKey: Buffer.from(generateSignalPubKey(kp.public))
        });
        const ourIdentity = {
            privKey: Buffer.from(creds.signedIdentityKey.private),
            pubKey: Buffer.from(generateSignalPubKey(creds.signedIdentityKey.public))
        };
        this.storage = {
            loadSession: async (id) => {
                const wireId = await this.resolveWireId(id);
                let { [wireId]: sess } = await keys.get('session', [wireId]);
                if (!sess) {
                    // The mapping may have appeared after the session was stored (or been
                    // lost on restart): fall back to the other addressing form so a
                    // PN-keyed session still serves a LID-addressed message, and vice
                    // versa.
                    const altId = await this.altWireId(wireId);
                    if (altId)
                        sess = (await keys.get('session', [altId]))[altId];
                }
                if (!sess)
                    return null;
                const data = typeof sess === 'string' ? JSON.parse(sess) : sess;
                return SessionRecord.deserialize(data);
            },
            storeSession: async (id, record) => {
                const wireId = await this.resolveWireId(id);
                await keys.set({ session: { [wireId]: record.serialize() } });
            },
            isTrustedIdentity: async () => true, // TOFU, as WhatsApp Web does
            loadPreKey: async (id) => {
                const { [id.toString()]: key } = await keys.get('pre-key', [id.toString()]);
                if (!key)
                    return undefined;
                const kp = key;
                return { privKey: Buffer.from(kp.private), pubKey: Buffer.from(generateSignalPubKey(kp.public)) };
            },
            removePreKey: async (id) => {
                await keys.set({ 'pre-key': { [id]: null } });
            },
            loadSignedPreKey: async () => ({
                privKey: Buffer.from(creds.signedPreKey.keyPair.private),
                pubKey: Buffer.from(generateSignalPubKey(creds.signedPreKey.keyPair.public))
            }),
            getOurRegistrationId: () => creds.registrationId,
            getOurIdentity: () => ourIdentity
        };
        this.groupStore = {
            loadSenderKey: async (name) => {
                const { [name]: raw } = await keys.get('sender-key', [name]);
                if (!raw)
                    return new SenderKeyRecord();
                const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return SenderKeyRecord.deserialize(data);
            },
            storeSenderKey: async (name, record) => {
                await keys.set({ 'sender-key': { [name]: JSON.stringify(record.serialize()) } });
            }
        };
    }
    /** The Signal storage key for a JID, matching the wire addressing form. */
    jidToSignalAddress(jid) {
        const decoded = jidDecode(jid);
        const domainType = decoded.domainType ?? WAJIDDomains.WHATSAPP;
        const user = domainType !== WAJIDDomains.WHATSAPP ? `${decoded.user}_${domainType}` : decoded.user;
        return `${user}.${decoded.device ?? 0}`;
    }
    /** Map a PN signal address to its LID equivalent when a mapping exists. */
    async resolveWireId(id) {
        if (!id.includes('.'))
            return id;
        const [userDevice, device] = id.split('.');
        const [user, domainTypeStr] = userDevice.split('_');
        const domainType = parseInt(domainTypeStr || '0', 10);
        if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID)
            return id;
        const pnJid = jidNormalizedUser(`${user}${device !== '0' ? `:${device}` : ''}@s.whatsapp.net`);
        const lidJid = await this.lidMapping.getLIDForPN(pnJid);
        if (!lidJid)
            return id;
        // Key the LID form exactly as `address()` does, so a session stored under
        // either addressing form is reachable from the other.
        return this.jidToSignalAddress(lidJid);
    }
    address(jid) {
        return this.jidToSignalAddress(jid);
    }
    /**
     * The counterpart storage key for an address whose record was not found —
     * the LID form of a PN key, or the PN form of a LID key. Uses the stored LID
     * mapping when present and falls back to the stanza-level `@lid` form, so a
     * session survives whichever addressing form the server chose first.
     */
    async altWireId(resolved) {
        const [userDevice, device] = resolved.split('.');
        const [user, domainTypeStr] = userDevice.split('_');
        const domainType = parseInt(domainTypeStr || '0', 10);
        const dev = device ?? '0';
        if (domainType === WAJIDDomains.WHATSAPP) {
            const lid = await this.lidMapping.getLIDForPN(jidNormalizedUser(`${user}:${dev}@s.whatsapp.net`));
            return lid ? this.jidToSignalAddress(lid) : undefined;
        }
        if (domainType === WAJIDDomains.LID) {
            const pn = await this.lidMapping.getPNForLID(jidNormalizedUser(`${user}:${dev}@lid`));
            if (pn)
                return this.jidToSignalAddress(pn);
            return `${user}.${dev}`;
        }
        return undefined;
    }
    /**
     * Re-key a stored session from one addressing form to another (PN → LID).
     * The server may start addressing a peer by LID after the session was opened
     * against its phone number; without migrating, the LID-addressed message
     * finds no session and is silently dropped. The source key is kept as a
     * fallback because the LID mapping itself is in-memory and lost on restart.
     */
    async migrateSession(fromJid, toJid) {
        if (!fromJid || !toJid)
            return;
        const from = this.jidToSignalAddress(fromJid);
        const to = this.jidToSignalAddress(toJid);
        if (from === to)
            return;
        // Read the raw record: `loadSession` would already redirect through the
        // just-stored mapping and miss the source key.
        const { [from]: raw } = await this.auth.keys.get('session', [from]);
        if (!raw)
            return;
        const record = SessionRecord.deserialize(typeof raw === 'string' ? JSON.parse(raw) : raw);
        await this.auth.keys.set({ session: { [to]: record.serialize() } });
    }
    async hasSession(jid) {
        const record = await this.storage.loadSession(this.address(jid));
        return Boolean(record?.getOpenSession());
    }
    async injectE2ESession(jid, bundle) {
        const builder = new SessionBuilder(this.storage, this.address(jid));
        await builder.initOutgoing(bundle);
    }
    async encryptMessage(jid, data) {
        const cipher = new SessionCipher(this.storage, this.address(jid));
        const { type, body } = await cipher.encrypt(Buffer.from(data));
        return { type: type === 3 ? 'pkmsg' : 'msg', ciphertext: body };
    }
    async decryptMessage(jid, type, ciphertext) {
        const cipher = new SessionCipher(this.storage, this.address(jid));
        return type === 'pkmsg'
            ? cipher.decryptPreKeyWhisperMessage(Buffer.from(ciphertext))
            : cipher.decryptWhisperMessage(Buffer.from(ciphertext));
    }
    async validateSession(jid) {
        return { exists: await this.hasSession(jid) };
    }
    // -- group sender keys ---------------------------------------------------
    async hasSenderKey(group, senderId, senderDevice) {
        return hasSenderKey(this.groupStore, senderKeyName(group, senderId, senderDevice));
    }
    async createSenderKeyDistribution(group, senderId, senderDevice) {
        const { buildSenderKeyDistribution } = await import('./group.js');
        const { serialized } = await buildSenderKeyDistribution(this.groupStore, senderKeyName(group, senderId, senderDevice));
        return serialized;
    }
    async processSenderKeyDistribution(group, authorJid, serialized) {
        const decoded = jidDecode(authorJid);
        await processSkdm(this.groupStore, senderKeyName(group, decoded.user, decoded.device ?? 0), serialized);
    }
    async encryptGroupMessage(group, senderId, senderDevice, data) {
        return encryptGroupMessage(this.groupStore, senderKeyName(group, senderId, senderDevice), data);
    }
    async decryptGroupMessage(group, authorJid, data) {
        const decoded = jidDecode(authorJid);
        return decryptGroupMessage(this.groupStore, senderKeyName(group, decoded.user, decoded.device ?? 0), data);
    }
}
//# sourceMappingURL=repository.js.map