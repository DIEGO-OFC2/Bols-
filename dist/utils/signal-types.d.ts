import type { KeyPair, SignedKeyPair } from '../crypto/index.js';
/** The subset of credentials needed to build a registration node. */
export interface SignalCreds {
    registrationId: number;
    signedPreKey: SignedKeyPair;
    signedIdentityKey: KeyPair;
}
//# sourceMappingURL=signal-types.d.ts.map