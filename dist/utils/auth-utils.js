import { Curve, signedKeyPair } from '../crypto/index.js';
import { generateRegistrationId, randomBase64 } from './generics.js';
export const initAuthCreds = () => {
    const identityKey = Curve.generateKeyPair();
    return {
        noiseKey: Curve.generateKeyPair(),
        pairingEphemeralKeyPair: Curve.generateKeyPair(),
        signedIdentityKey: identityKey,
        signedPreKey: signedKeyPair(identityKey, 1),
        registrationId: generateRegistrationId(),
        advSecretKey: randomBase64(32),
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        registered: false
    };
};
/** In-memory store for tests and short-lived sessions. */
export const makeInMemoryKeyStore = () => {
    const store = {};
    return {
        get: async (type, ids) => {
            const bucket = store[type] ?? {};
            const out = {};
            for (const id of ids)
                if (bucket[id] !== undefined)
                    out[id] = bucket[id];
            return out;
        },
        set: async (data) => {
            for (const [type, values] of Object.entries(data)) {
                store[type] = store[type] ?? {};
                if (values === null)
                    continue;
                for (const [id, value] of Object.entries(values)) {
                    if (value === null)
                        delete store[type][id];
                    else
                        store[type][id] = value;
                }
            }
        }
    };
};
export const initAuthState = (keys = makeInMemoryKeyStore()) => ({
    creds: initAuthCreds(),
    keys
});
//# sourceMappingURL=auth-utils.js.map