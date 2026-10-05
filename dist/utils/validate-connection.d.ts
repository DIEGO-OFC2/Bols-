import type { KeyPair } from '../crypto/index.js';
import { type ClientPayload } from '../proto/client-payload.js';
import { accountSignaturePrefix, encodeADVSignedDeviceIdentity, type ADVSignedDeviceIdentity } from '../proto/device-identity.js';
import type { BinaryNode } from '../wabinary/types.js';
import type { AuthenticationCreds, SignalIdentity } from './auth-utils.js';
import type { SignalCreds } from './signal-types.js';
export declare const KEY_BUNDLE_TYPE: Buffer<ArrayBuffer>;
declare const WA_ADV_ACCOUNT_SIG_PREFIX: Buffer<ArrayBuffer>;
declare const WA_ADV_DEVICE_SIG_PREFIX: Buffer<ArrayBuffer>;
export interface ConnectionConfig {
    version: [number, number, number];
    browser: [string, string, string];
    countryCode?: string;
    syncFullHistory?: boolean;
    pushName?: string;
}
export declare const generateLoginNode: (userJid: string, config: ConnectionConfig) => ClientPayload;
export declare const generateRegistrationNode: (creds: SignalCreds, config: ConnectionConfig) => ClientPayload;
/**
 * Decrypt the server's wrapped primary ephemeral public key using the pairing
 * code derived key (salt ‖ iv ‖ ciphertext layout).
 */
export declare const decipherLinkPublicKey: (data: Uint8Array, pairingCode: string) => Promise<Buffer>;
export interface CompanionFinishResult {
    node: BinaryNode;
    advSecretKey: string;
}
/**
 * Complete the pairing-code flow: derive the link-code bundle, wrap it for the
 * primary device, and produce the `companion_finish` stanza plus the rotated
 * adv secret key.
 */
export declare const buildCompanionFinish: (stanza: BinaryNode, creds: Pick<AuthenticationCreds, "pairingCode" | "pairingEphemeralKeyPair" | "signedIdentityKey">, companionJid: string, messageId: string) => Promise<CompanionFinishResult>;
export declare const createSignalIdentity: (wid: string, accountSignatureKey: Uint8Array) => SignalIdentity;
export interface PairingResult {
    creds: Partial<AuthenticationCreds>;
    reply: BinaryNode;
}
/** Validate and answer the server's <pair-success> stanza. */
export declare const configureSuccessfulPairing: (stanza: BinaryNode, { advSecretKey, signedIdentityKey, signalIdentities }: Pick<AuthenticationCreds, "advSecretKey" | "signedIdentityKey" | "signalIdentities">) => PairingResult;
export { encodeADVSignedDeviceIdentity, accountSignaturePrefix, WA_ADV_DEVICE_SIG_PREFIX, WA_ADV_ACCOUNT_SIG_PREFIX };
export type { ADVSignedDeviceIdentity, KeyPair, SignalCreds };
//# sourceMappingURL=validate-connection.d.ts.map