import { createHash, randomBytes } from 'node:crypto';
import { Curve, aesDecryptCTR, aesEncryptGCM, derivePairingCodeKey, generateSignalPubKey, hkdf, hmacSign, md5 } from '../crypto/index.js';
import { ConnectReason, ConnectType, PlatformType, Product } from '../proto/client-payload.js';
import { encodeDeviceProps } from '../proto/client-payload.js';
import { ADVEncryptionType, accountSignaturePrefix, decodeADVSignedDeviceIdentity, decodeADVSignedDeviceIdentityHMAC, decodeADVDeviceIdentity, encodeADVSignedDeviceIdentity } from '../proto/device-identity.js';
import { getBinaryNodeChild } from '../wabinary/generic-utils.js';
import { jidDecode, S_WHATSAPP_NET } from '../wabinary/jid.js';
import { encodeBigEndian } from './generics.js';
export const KEY_BUNDLE_TYPE = Buffer.from([5]);
const EMPTY = Buffer.alloc(0);
const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0]);
const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1]);
const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5]);
const toPlatform = (browser) => browser.toLowerCase().includes('android') ? 0 : 14; /* WEB */
const getPlatformType = (platform) => {
    const upper = platform.toUpperCase();
    if (upper === 'ANDROID')
        return PlatformType.ANDROID_PHONE;
    return PlatformType[upper] ?? PlatformType.CHROME;
};
const getUserAgent = (config) => ({
    appVersion: {
        primary: config.version[0],
        secondary: config.version[1],
        tertiary: config.version[2]
    },
    platform: toPlatform(config.browser[1]),
    releaseChannel: 0,
    osVersion: '0.1',
    device: 'Desktop',
    osBuildNumber: '0.1',
    localeLanguageIso6391: 'en',
    mnc: '000',
    mcc: '000',
    localeCountryIso31661Alpha2: config.countryCode ?? 'US'
});
const getWebInfo = (config) => {
    let webSubPlatform = 0; /* WEB_BROWSER */
    if (config.syncFullHistory && config.browser[1] === 'Desktop') {
        if (config.browser[0] === 'Mac OS')
            webSubPlatform = 3; /* DARWIN */
        else if (config.browser[0] === 'Windows')
            webSubPlatform = 5; /* WIN_HYBRID */
    }
    return { webSubPlatform };
};
const getClientPayload = (config) => {
    const payload = {
        connectType: ConnectType.WIFI_UNKNOWN,
        connectReason: ConnectReason.USER_ACTIVATED,
        userAgent: getUserAgent(config)
    };
    if (!config.browser[1].toLowerCase().includes('android'))
        payload.webInfo = getWebInfo(config);
    if (config.pushName)
        payload.pushName = config.pushName;
    return payload;
};
export const generateLoginNode = (userJid, config) => {
    const decoded = jidDecode(userJid);
    return {
        ...getClientPayload(config),
        passive: true,
        pull: true,
        username: BigInt(decoded.user),
        device: decoded.device,
        lidDbMigrated: false
    };
};
export const generateRegistrationNode = (creds, config) => {
    const appVersionBuf = md5(Buffer.from(config.version.join('.')));
    const companion = {
        os: config.browser[0],
        platformType: getPlatformType(config.browser[1]),
        requireFullSync: config.syncFullHistory ?? true,
        version: { primary: 10, secondary: 15, tertiary: 7 },
        historySyncConfig: {
            storageQuotaMb: 10240,
            inlineInitialPayloadInE2EeMsg: true,
            supportCallLogHistory: false,
            supportBotUserAgentChatHistory: true,
            supportCagReactionsAndPolls: true,
            supportBizHostedMsg: true,
            supportRecentSyncChunkMessageCountTuning: true,
            supportHostedGroupMsg: true,
            supportFbidBotChatHistory: true,
            supportMessageAssociation: true,
            supportGroupHistory: false
        }
    };
    const companionProto = encodeDeviceProps(companion);
    return {
        ...getClientPayload(config),
        passive: false,
        pull: false,
        devicePairingData: {
            buildHash: appVersionBuf,
            deviceProps: companionProto,
            eRegid: encodeBigEndian(creds.registrationId),
            eKeytype: KEY_BUNDLE_TYPE,
            eIdent: creds.signedIdentityKey.public,
            eSkeyId: encodeBigEndian(creds.signedPreKey.keyId, 3),
            eSkeyVal: creds.signedPreKey.keyPair.public,
            eSkeySig: creds.signedPreKey.signature
        }
    };
};
/**
 * Decrypt the server's wrapped primary ephemeral public key using the pairing
 * code derived key (salt ‖ iv ‖ ciphertext layout).
 */
export const decipherLinkPublicKey = async (data, pairingCode) => {
    const buf = Buffer.from(data);
    const salt = buf.subarray(0, 32);
    const iv = buf.subarray(32, 48);
    const payload = buf.subarray(48, 80);
    const key = await derivePairingCodeKey(pairingCode, salt);
    return aesDecryptCTR(payload, key, iv);
};
/**
 * Complete the pairing-code flow: derive the link-code bundle, wrap it for the
 * primary device, and produce the `companion_finish` stanza plus the rotated
 * adv secret key.
 */
export const buildCompanionFinish = async (stanza, creds, companionJid, messageId) => {
    const reg = stanza.tag === 'link_code_companion_reg'
        ? stanza
        : getBinaryNodeChild(stanza, 'link_code_companion_reg');
    if (!reg)
        throw new Error('missing link_code_companion_reg');
    const ref = getBinaryNodeChild(reg, 'link_code_pairing_ref')?.content;
    const primaryIdentityPublic = getBinaryNodeChild(reg, 'primary_identity_pub')?.content;
    const wrappedPrimaryEphemeral = getBinaryNodeChild(reg, 'link_code_pairing_wrapped_primary_ephemeral_pub')
        ?.content;
    if (!ref || !primaryIdentityPublic || !wrappedPrimaryEphemeral) {
        throw new Error('incomplete link_code_companion_reg stanza');
    }
    const primaryEphemeralPublic = await decipherLinkPublicKey(wrappedPrimaryEphemeral, creds.pairingCode);
    const companionSharedKey = Curve.sharedKey(creds.pairingEphemeralKeyPair.private, primaryEphemeralPublic);
    const linkCodeSalt = randomBytes(32);
    const linkCodePairingExpanded = hkdf(companionSharedKey, 32, {
        salt: linkCodeSalt,
        info: 'link_code_pairing_key_bundle_encryption_key'
    });
    const random = randomBytes(32);
    const encryptPayload = Buffer.concat([
        Buffer.from(creds.signedIdentityKey.public),
        primaryIdentityPublic,
        random
    ]);
    const encryptIv = randomBytes(12);
    const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, EMPTY);
    const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted]);
    const identitySharedKey = Curve.sharedKey(creds.signedIdentityKey.private, primaryIdentityPublic);
    const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random]);
    const advSecretKey = Buffer.from(hkdf(identityPayload, 32, { info: 'adv_secret' })).toString('base64');
    const node = {
        tag: 'iq',
        attrs: { to: S_WHATSAPP_NET, type: 'set', id: messageId, xmlns: 'md' },
        content: [
            {
                tag: 'link_code_companion_reg',
                attrs: { jid: companionJid, stage: 'companion_finish' },
                content: [
                    { tag: 'link_code_pairing_wrapped_key_bundle', attrs: {}, content: encryptedPayload },
                    { tag: 'companion_identity_public', attrs: {}, content: creds.signedIdentityKey.public },
                    { tag: 'link_code_pairing_ref', attrs: {}, content: ref }
                ]
            }
        ]
    };
    return { node, advSecretKey };
};
export const createSignalIdentity = (wid, accountSignatureKey) => ({
    identifier: { name: wid, deviceId: 0 },
    identifierKey: generateSignalPubKey(accountSignatureKey)
});
/** Validate and answer the server's <pair-success> stanza. */
export const configureSuccessfulPairing = (stanza, { advSecretKey, signedIdentityKey, signalIdentities }) => {
    const msgId = stanza.attrs.id;
    const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success');
    if (!pairSuccessNode)
        throw new Error('missing pair-success node');
    const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity');
    const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform');
    const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device');
    const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz');
    if (!deviceIdentityNode || !deviceNode) {
        throw new Error('missing device-identity or device in pair success node');
    }
    const bizName = businessNode?.attrs.name;
    const jid = deviceNode.attrs.jid;
    const lid = deviceNode.attrs.lid;
    const { details, hmac, accountType } = decodeADVSignedDeviceIdentityHMAC(deviceIdentityNode.content);
    const hmacPrefix = accountType === ADVEncryptionType.HOSTED ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX : Buffer.alloc(0);
    const advSign = hmacSign(Buffer.concat([hmacPrefix, details]), Buffer.from(advSecretKey, 'base64'));
    if (!hmac || Buffer.compare(hmac, advSign) !== 0)
        throw new Error('invalid account signature');
    const account = decodeADVSignedDeviceIdentity(details);
    const { accountSignatureKey, accountSignature, details: deviceDetails } = account;
    const deviceIdentity = decodeADVDeviceIdentity(deviceDetails);
    const accountSignaturePrefix = deviceIdentity.deviceType === ADVEncryptionType.HOSTED
        ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
        : WA_ADV_ACCOUNT_SIG_PREFIX;
    const accountMsg = Buffer.concat([accountSignaturePrefix, deviceDetails, signedIdentityKey.public]);
    if (!Curve.verify(accountSignatureKey, accountMsg, accountSignature)) {
        throw new Error('failed to verify account signature');
    }
    const deviceMsg = Buffer.concat([
        WA_ADV_DEVICE_SIG_PREFIX,
        deviceDetails,
        signedIdentityKey.public,
        accountSignatureKey
    ]);
    account.deviceSignature = Curve.sign(signedIdentityKey.private, deviceMsg);
    const identity = createSignalIdentity(lid, accountSignatureKey);
    const accountEnc = encodeADVSignedDeviceIdentity(account, false);
    const reply = {
        tag: 'iq',
        attrs: { to: S_WHATSAPP_NET, type: 'result', id: msgId },
        content: [
            {
                tag: 'pair-device-sign',
                attrs: {},
                content: [{ tag: 'device-identity', attrs: { 'key-index': deviceIdentity.keyIndex.toString() }, content: accountEnc }]
            }
        ]
    };
    return {
        creds: {
            account: account,
            me: { id: jid, name: bizName, lid },
            signalIdentities: [...(signalIdentities ?? []), identity],
            platform: platformNode?.attrs.name
        },
        reply
    };
};
export { encodeADVSignedDeviceIdentity, accountSignaturePrefix, WA_ADV_DEVICE_SIG_PREFIX, WA_ADV_ACCOUNT_SIG_PREFIX };
void createHash;
void Product;
//# sourceMappingURL=validate-connection.js.map