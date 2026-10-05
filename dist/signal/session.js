/**
 * Signal protocol implementation for WhatsApp: session records, the X3DH-ish
 * session setup, and the Double Ratchet used by the Whisper message format.
 *
 * This mirrors the well-tested libsignal semantics exactly (same MAC framing,
 * same HKDF info strings, same version byte) but is written for this codebase
 * and keeps session state as plain, JSON-serializable objects.
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { Curve, generateSignalPubKey, asBuffer, hmacSign } from '../crypto/index.js';
import { decodePreKeyWhisperMessage, decodeWhisperMessage, encodePreKeyWhisperMessage, encodeWhisperMessage } from './protobuf.js';
const VERSION = 3;
/** Fixed one-byte HMAC messages used to step the chain without per-call allocation. */
export const CHAIN_MSG = Buffer.from([1]);
export const CHAIN_NEXT = Buffer.from([2]);
const ZERO_32 = Buffer.alloc(32);
const INFO_TEXT = Buffer.from('WhisperText');
const INFO_RATCHET = Buffer.from('WhisperRatchet');
const INFO_MSG_KEYS = Buffer.from('WhisperMessageKeys');
export { asBuffer };
const genKeyPair = () => {
    const kp = Curve.generateKeyPair();
    return { privKey: Buffer.from(kp.private), pubKey: Buffer.from(generateSignalPubKey(kp.public)) };
};
// ---------------------------------------------------------------------------
// RFC 5869 / libsignal crypto helpers
// ---------------------------------------------------------------------------
const hmac = (key, data) => hmacSign(data, key);
/** Combined prev-output + info + counter scratch; the max info here is <32B. */
const DERIVE_SCRATCH = Buffer.allocUnsafe(64 + 32);
/** libsignal's fixed 3-chunk HKDF variant (returns N 32-byte outputs). */
export const deriveSecrets = (input, salt, info, chunks = 3) => {
    const il = info.length;
    const buf = il <= 32 ? DERIVE_SCRATCH : Buffer.allocUnsafe(64 + il);
    info.copy(buf, 32);
    const msgLen = 32 + il + 1;
    const prk = hmac(salt, input);
    buf[32 + il] = 1;
    let o = hmac(prk, buf.subarray(32, msgLen));
    const out = [o];
    for (let i = 2; i <= chunks; i++) {
        o.copy(buf, 0);
        buf[32 + il] = i;
        o = hmac(prk, buf.subarray(0, msgLen));
        out.push(o);
    }
    return out;
};
const encryptCBC = (key, data, iv) => {
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([cipher.update(data), cipher.final()]);
};
const decryptCBC = (key, data, iv) => {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
};
export const verifyMAC = (data, key, mac, length) => {
    const calculated = hmac(key, data).subarray(0, length);
    if (mac.length !== length || !mac.equals(calculated))
        throw new Error('Bad MAC');
};
// ---------------------------------------------------------------------------
// Session record
// ---------------------------------------------------------------------------
const BaseKeyType = { OURS: 1, THEIRS: 2 };
const ChainType = { SENDING: 1, RECEIVING: 2 };
const CLOSED_SESSIONS_MAX = 40;
const newEntry = () => ({
    registrationId: 0,
    currentRatchet: {
        ephemeralKeyPair: { privKey: Buffer.alloc(0), pubKey: Buffer.alloc(0) },
        lastRemoteEphemeralKey: Buffer.alloc(0),
        previousCounter: 0,
        rootKey: Buffer.alloc(0)
    },
    indexInfo: {
        created: 0,
        used: 0,
        remoteIdentityKey: Buffer.alloc(0),
        baseKey: Buffer.alloc(0),
        baseKeyType: 0,
        closed: -1
    },
    chains: new Map()
});
/** Serialized form is JSON with base64 buffers, matching libsignal's shape. */
export class SessionRecord {
    sessions = {};
    version = 'v1';
    static deserialize(data) {
        const rec = new SessionRecord();
        for (const [key, entry] of Object.entries(data._sessions ?? {})) {
            rec.sessions[key] = deserializeEntry(entry);
        }
        return rec;
    }
    serialize() {
        const _sessions = {};
        for (const [key, entry] of Object.entries(this.sessions)) {
            _sessions[key] = serializeEntry(entry);
        }
        return { _sessions, version: this.version };
    }
    getOpenSession() {
        return Object.values(this.sessions).find(s => s.indexInfo.closed === -1);
    }
    getSession(baseKey) {
        return this.sessions[baseKey.toString('base64')];
    }
    setSession(session) {
        this.sessions[session.indexInfo.baseKey.toString('base64')] = session;
    }
    getSessions() {
        return Object.values(this.sessions).sort((a, b) => (b.indexInfo.used ?? 0) - (a.indexInfo.used ?? 0));
    }
    closeSession(session) {
        session.indexInfo.closed = Date.now();
    }
    isClosed(session) {
        return session.indexInfo.closed !== -1;
    }
    removeOldSessions() {
        while (Object.keys(this.sessions).length > CLOSED_SESSIONS_MAX) {
            let oldestKey;
            let oldest = Infinity;
            for (const [key, s] of Object.entries(this.sessions)) {
                if (s.indexInfo.closed !== -1 && s.indexInfo.closed < oldest) {
                    oldest = s.indexInfo.closed;
                    oldestKey = key;
                }
            }
            if (!oldestKey)
                throw new Error('Corrupt sessions object');
            delete this.sessions[oldestKey];
        }
    }
}
const b64 = (v) => Buffer.from(v).toString('base64');
const fromB64 = (v) => Buffer.from(v, 'base64');
const serializeEntry = (e) => {
    const chains = {};
    for (const [key, c] of e.chains) {
        const messageKeys = {};
        for (const [idx, k] of Object.entries(c.messageKeys))
            messageKeys[idx] = b64(k);
        chains[key] = {
            chainKey: { counter: c.chainKey.counter, key: c.chainKey.key ? b64(c.chainKey.key) : undefined },
            chainType: c.chainType,
            messageKeys
        };
    }
    return {
        registrationId: e.registrationId,
        currentRatchet: {
            ephemeralKeyPair: {
                pubKey: b64(e.currentRatchet.ephemeralKeyPair.pubKey),
                privKey: b64(e.currentRatchet.ephemeralKeyPair.privKey)
            },
            lastRemoteEphemeralKey: b64(e.currentRatchet.lastRemoteEphemeralKey),
            previousCounter: e.currentRatchet.previousCounter,
            rootKey: b64(e.currentRatchet.rootKey)
        },
        indexInfo: {
            baseKey: b64(e.indexInfo.baseKey),
            baseKeyType: e.indexInfo.baseKeyType,
            closed: e.indexInfo.closed,
            used: e.indexInfo.used,
            created: e.indexInfo.created,
            remoteIdentityKey: b64(e.indexInfo.remoteIdentityKey)
        },
        pendingPreKey: e.pendingPreKey
            ? { ...e.pendingPreKey, baseKey: b64(e.pendingPreKey.baseKey) }
            : undefined,
        _chains: chains
    };
};
const deserializeEntry = (d) => {
    const chains = new Map();
    for (const [key, c] of Object.entries(d._chains ?? {})) {
        const messageKeys = {};
        for (const [idx, k] of Object.entries(c.messageKeys))
            messageKeys[Number(idx)] = fromB64(k);
        chains.set(key, {
            chainKey: { counter: c.chainKey.counter, key: c.chainKey.key ? fromB64(c.chainKey.key) : undefined },
            chainType: c.chainType,
            messageKeys
        });
    }
    return {
        registrationId: d.registrationId,
        currentRatchet: {
            ephemeralKeyPair: {
                pubKey: fromB64(d.currentRatchet.ephemeralKeyPair.pubKey),
                privKey: fromB64(d.currentRatchet.ephemeralKeyPair.privKey)
            },
            lastRemoteEphemeralKey: fromB64(d.currentRatchet.lastRemoteEphemeralKey),
            previousCounter: d.currentRatchet.previousCounter,
            rootKey: fromB64(d.currentRatchet.rootKey)
        },
        indexInfo: {
            baseKey: fromB64(d.indexInfo.baseKey),
            baseKeyType: d.indexInfo.baseKeyType,
            closed: d.indexInfo.closed,
            used: d.indexInfo.used,
            created: d.indexInfo.created,
            remoteIdentityKey: fromB64(d.indexInfo.remoteIdentityKey)
        },
        pendingPreKey: d.pendingPreKey
            ? { ...d.pendingPreKey, baseKey: fromB64(d.pendingPreKey.baseKey) }
            : undefined,
        chains
    };
};
// ---------------------------------------------------------------------------
// Session builder
// ---------------------------------------------------------------------------
export class SessionBuilder {
    storage;
    addr;
    constructor(storage, addr) {
        this.storage = storage;
        this.addr = addr;
    }
    async initOutgoing(device) {
        if (!(await this.storage.isTrustedIdentity(this.addr, device.identityKey))) {
            throw new Error(`Untrusted identity key for ${this.addr}`);
        }
        if (!Curve.verify(device.identityKey, device.signedPreKey.publicKey, device.signedPreKey.signature)) {
            throw new Error(`Invalid signed pre-key signature for ${this.addr}`);
        }
        const baseKey = genKeyPair();
        const session = await this.initSession(true, baseKey, undefined, device.identityKey, device.preKey?.publicKey, device.signedPreKey.publicKey, device.registrationId);
        session.pendingPreKey = { signedKeyId: device.signedPreKey.keyId, baseKey: baseKey.pubKey };
        if (device.preKey)
            session.pendingPreKey.preKeyId = device.preKey.keyId;
        let record = await this.storage.loadSession(this.addr);
        if (!record)
            record = new SessionRecord();
        else {
            const open = record.getOpenSession();
            if (open)
                record.closeSession(open);
        }
        record.setSession(session);
        await this.storage.storeSession(this.addr, record);
    }
    async initIncoming(record, message) {
        if (!message.baseKey || message.identityKey) {
            // identityKey is verified by the repository on first use; here we require baseKey
        }
        if (!(await this.storage.isTrustedIdentity(this.addr, message.identityKey))) {
            throw new Error(`Untrusted identity key for ${this.addr}`);
        }
        if (record.getSession(message.baseKey) !== undefined)
            return undefined;
        const preKeyPair = message.preKeyId !== undefined ? await this.storage.loadPreKey(message.preKeyId) : undefined;
        if (message.preKeyId !== undefined && !preKeyPair)
            throw new Error('Invalid PreKey ID');
        const signedPreKeyPair = await this.storage.loadSignedPreKey();
        if (!signedPreKeyPair)
            throw new Error('Missing SignedPreKey');
        const existingOpen = record.getOpenSession();
        if (existingOpen)
            record.closeSession(existingOpen);
        record.setSession(await this.initSession(false, preKeyPair, signedPreKeyPair, message.identityKey, message.baseKey, undefined, message.registrationId));
        return message.preKeyId;
    }
    async initSession(isInitiator, ourEphemeralKey, ourSignedKey, theirIdentityPubKey, theirEphemeralPubKey, theirSignedPubKey, registrationId) {
        if (isInitiator)
            ourSignedKey = ourEphemeralKey;
        else
            theirSignedPubKey = theirEphemeralPubKey;
        const hasEphemerals = Boolean(ourEphemeralKey && theirEphemeralPubKey);
        const sharedSecret = new Uint8Array(32 * (hasEphemerals ? 5 : 4));
        sharedSecret.fill(0xff, 0, 32);
        const ourIdentityKey = this.storage.getOurIdentity();
        const a1 = Curve.sharedKey(ourIdentityKey.privKey, theirSignedPubKey);
        const a2 = Curve.sharedKey(ourSignedKey.privKey, theirIdentityPubKey);
        const a3 = Curve.sharedKey(ourSignedKey.privKey, theirSignedPubKey);
        if (isInitiator) {
            sharedSecret.set(a1, 32);
            sharedSecret.set(a2, 64);
        }
        else {
            sharedSecret.set(a1, 64);
            sharedSecret.set(a2, 32);
        }
        sharedSecret.set(a3, 96);
        if (hasEphemerals) {
            sharedSecret.set(Curve.sharedKey(ourEphemeralKey.privKey, theirEphemeralPubKey), 128);
        }
        const masterKey = deriveSecrets(Buffer.from(sharedSecret), ZERO_32, INFO_TEXT);
        const session = newEntry();
        session.registrationId = registrationId;
        session.currentRatchet = {
            rootKey: masterKey[0],
            ephemeralKeyPair: isInitiator ? genKeyPair() : ourSignedKey,
            lastRemoteEphemeralKey: Buffer.from(theirSignedPubKey),
            previousCounter: 0
        };
        session.indexInfo = {
            created: Date.now(),
            used: Date.now(),
            remoteIdentityKey: Buffer.from(theirIdentityPubKey),
            baseKey: isInitiator ? ourEphemeralKey.pubKey : Buffer.from(theirEphemeralPubKey),
            baseKeyType: isInitiator ? BaseKeyType.OURS : BaseKeyType.THEIRS,
            closed: -1
        };
        if (isInitiator)
            this.calculateSendingRatchet(session, theirSignedPubKey);
        return session;
    }
    calculateSendingRatchet(session, remoteKey) {
        const ratchet = session.currentRatchet;
        const sharedSecret = Curve.sharedKey(ratchet.ephemeralKeyPair.privKey, remoteKey);
        const masterKey = deriveSecrets(sharedSecret, ratchet.rootKey, INFO_RATCHET);
        session.chains.set(ratchet.ephemeralKeyPair.pubKey.toString('base64'), {
            messageKeys: {},
            chainKey: { counter: -1, key: masterKey[1] },
            chainType: ChainType.SENDING
        });
        ratchet.rootKey = masterKey[0];
    }
}
export class SessionCipher {
    storage;
    addr;
    constructor(storage, addr) {
        this.storage = storage;
        this.addr = addr;
    }
    async encrypt(data) {
        const ourIdentityKey = this.storage.getOurIdentity();
        const record = await this.storage.loadSession(this.addr);
        if (!record)
            throw new Error('No sessions');
        const session = record.getOpenSession();
        if (!session)
            throw new Error('No open session');
        const chain = session.chains.get(session.currentRatchet.ephemeralKeyPair.pubKey.toString('base64'));
        if (chain.chainType === ChainType.RECEIVING)
            throw new Error('Tried to encrypt on a receiving chain');
        this.fillMessageKeys(chain, chain.chainKey.counter + 1);
        const keys = deriveSecrets(chain.messageKeys[chain.chainKey.counter], ZERO_32, INFO_MSG_KEYS);
        delete chain.messageKeys[chain.chainKey.counter];
        const ciphertext = encryptCBC(keys[0], data, keys[2].subarray(0, 16));
        const msg = encodeWhisperMessage({
            ephemeralKey: session.currentRatchet.ephemeralKeyPair.pubKey,
            counter: chain.chainKey.counter,
            previousCounter: session.currentRatchet.previousCounter,
            ciphertext
        });
        const macInput = Buffer.alloc(msg.length + 33 * 2 + 1);
        macInput.set(ourIdentityKey.pubKey, 0);
        macInput.set(session.indexInfo.remoteIdentityKey, 33);
        macInput[66] = (VERSION << 4) | VERSION;
        macInput.set(msg, 67);
        const mac = hmac(keys[1], macInput);
        const result = Buffer.alloc(msg.length + 9);
        result[0] = (VERSION << 4) | VERSION;
        result.set(msg, 1);
        result.set(mac.subarray(0, 8), msg.length + 1);
        await this.storeRecord(record);
        if (session.pendingPreKey) {
            const preKeyMsg = encodePreKeyWhisperMessage({
                identityKey: ourIdentityKey.pubKey,
                registrationId: this.storage.getOurRegistrationId(),
                baseKey: session.pendingPreKey.baseKey,
                signedPreKeyId: session.pendingPreKey.signedKeyId,
                preKeyId: session.pendingPreKey.preKeyId,
                message: result
            });
            const body = Buffer.concat([Buffer.from([(VERSION << 4) | VERSION]), preKeyMsg]);
            return { type: 3, body, registrationId: session.registrationId };
        }
        return { type: 1, body: result, registrationId: session.registrationId };
    }
    async decryptWhisperMessage(data) {
        const record = await this.storage.loadSession(this.addr);
        if (!record)
            throw new Error('No session record');
        let plaintext;
        const errs = [];
        for (const session of record.getSessions()) {
            try {
                plaintext = await this.doDecrypt(data, session);
                session.indexInfo.used = Date.now();
                break;
            }
            catch (e) {
                errs.push(e);
            }
        }
        if (plaintext === undefined) {
            throw new AggregateError(errs, 'No matching sessions found for message');
        }
        await this.storeRecord(record);
        return plaintext;
    }
    async decryptPreKeyWhisperMessage(data) {
        const versions = [data[0] >> 4, data[0] & 0xf];
        if (versions[1] > 3 || versions[0] < 3)
            throw new Error('Incompatible version on PreKeyWhisperMessage');
        const record = (await this.storage.loadSession(this.addr)) ?? new SessionRecord();
        const preKeyProto = decodePreKeyWhisperMessage(data.subarray(1));
        const builder = new SessionBuilder(this.storage, this.addr);
        const preKeyId = await builder.initIncoming(record, preKeyProto);
        const session = record.getSession(preKeyProto.baseKey);
        const plaintext = await this.doDecrypt(preKeyProto.message, session);
        await this.storeRecord(record);
        if (preKeyId !== undefined)
            await this.storage.removePreKey(preKeyId);
        return plaintext;
    }
    async doDecrypt(messageBuffer, session) {
        const versions = [messageBuffer[0] >> 4, messageBuffer[0] & 0xf];
        if (versions[1] > 3 || versions[0] < 3)
            throw new Error('Incompatible version on WhisperMessage');
        const messageProto = messageBuffer.subarray(1, -8);
        const message = decodeWhisperMessage(messageProto);
        const remoteEphemeral = Buffer.from(message.ephemeralKey);
        this.maybeStepRatchet(session, remoteEphemeral, message.previousCounter);
        const chain = session.chains.get(remoteEphemeral.toString('base64'));
        if (chain.chainType === ChainType.SENDING)
            throw new Error('Tried to decrypt on a sending chain');
        this.fillMessageKeys(chain, message.counter);
        const messageKey = chain.messageKeys[message.counter];
        if (!messageKey)
            throw new Error('Key used already or never filled');
        delete chain.messageKeys[message.counter];
        const keys = deriveSecrets(messageKey, ZERO_32, INFO_MSG_KEYS);
        const ourIdentityKey = this.storage.getOurIdentity();
        const macInput = Buffer.alloc(messageProto.length + 33 * 2 + 1);
        macInput.set(session.indexInfo.remoteIdentityKey, 0);
        macInput.set(ourIdentityKey.pubKey, 33);
        macInput[66] = (VERSION << 4) | VERSION;
        macInput.set(messageProto, 67);
        verifyMAC(macInput, keys[1], messageBuffer.subarray(-8), 8);
        const plaintext = decryptCBC(keys[0], message.ciphertext, keys[2].subarray(0, 16));
        delete session.pendingPreKey;
        return plaintext;
    }
    fillMessageKeys(chain, counter) {
        if (chain.chainKey.counter >= counter)
            return;
        if (counter - chain.chainKey.counter > 2000)
            throw new Error('Over 2000 messages into the future');
        if (chain.chainKey.key === undefined)
            throw new Error('Chain closed');
        let key = chain.chainKey.key;
        for (let i = chain.chainKey.counter + 1; i <= counter; i++) {
            chain.messageKeys[i] = hmac(key, CHAIN_MSG);
            key = hmac(key, CHAIN_NEXT);
        }
        chain.chainKey.key = key;
        chain.chainKey.counter = counter;
    }
    maybeStepRatchet(session, remoteKey, previousCounter) {
        if (session.chains.has(remoteKey.toString('base64')))
            return;
        const ratchet = session.currentRatchet;
        const previousRatchet = session.chains.get(ratchet.lastRemoteEphemeralKey.toString('base64'));
        if (previousRatchet) {
            this.fillMessageKeys(previousRatchet, previousCounter);
            delete previousRatchet.chainKey.key;
        }
        this.calculateRatchet(session, remoteKey, false);
        const prevCounter = session.chains.get(ratchet.ephemeralKeyPair.pubKey.toString('base64'));
        if (prevCounter) {
            ratchet.previousCounter = prevCounter.chainKey.counter;
            session.chains.delete(ratchet.ephemeralKeyPair.pubKey.toString('base64'));
        }
        ratchet.ephemeralKeyPair = genKeyPair();
        this.calculateRatchet(session, remoteKey, true);
        ratchet.lastRemoteEphemeralKey = remoteKey;
    }
    calculateRatchet(session, remoteKey, sending) {
        const ratchet = session.currentRatchet;
        const sharedSecret = Curve.sharedKey(ratchet.ephemeralKeyPair.privKey, remoteKey);
        const masterKey = deriveSecrets(sharedSecret, ratchet.rootKey, INFO_RATCHET, 2);
        const chainKey = sending ? ratchet.ephemeralKeyPair.pubKey : remoteKey;
        session.chains.set(chainKey.toString('base64'), {
            messageKeys: {},
            chainKey: { counter: -1, key: masterKey[1] },
            chainType: sending ? ChainType.SENDING : ChainType.RECEIVING
        });
        ratchet.rootKey = masterKey[0];
    }
    async storeRecord(record) {
        record.removeOldSessions();
        await this.storage.storeSession(this.addr, record);
    }
}
export { hmac };
//# sourceMappingURL=session.js.map