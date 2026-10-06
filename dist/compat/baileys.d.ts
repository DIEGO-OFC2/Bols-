import { Readable } from 'node:stream';
import { WAClient, DisconnectReason, DEFAULT_WA_VERSION, type SocketConfig } from '../socket/client.js';
import { type AuthenticationCreds, type AuthenticationState, type SignalKeyStore } from '../utils/auth-utils.js';
import { Browsers } from '../utils/browser-utils.js';
import { delay } from '../utils/generics.js';
import { jidDecode, jidEncode, jidNormalizedUser, isJidGroup, isJidBroadcast } from '../wabinary/jid.js';
import { getContentType, normalizeMessageContent, type IMessage, type MediaMessage } from '../proto/message.js';
import { type MediaType } from '../media/index.js';
export { DisconnectReason, Browsers, delay, jidNormalizedUser, jidEncode, jidDecode, isJidGroup, isJidBroadcast, getContentType, normalizeMessageContent };
export declare const isJidUser: (jid?: string) => boolean;
export declare const areJidsSameUser: (a?: string, b?: string) => boolean;
export declare const getDevice: (jid?: string) => number | undefined;
export declare const extractMessageContent: (msg: IMessage | undefined) => IMessage | undefined;
export declare enum WAMessageStubType {
    UNKNOWN = 0,
    REVOKE = 1,
    CIPHERTEXT = 2,
    REVOKE_CIPHERTEXT = 3
}
export declare enum WAMessageStatus {
    ERROR = 0,
    PENDING = 1,
    SERVER_ACK = 2,
    DELIVERY_ACK = 3,
    READ = 4,
    PLAYED = 5
}
export declare const proto: {
    Message: {
        create: <T>(message: T) => T;
    };
};
export { DEFAULT_WA_VERSION };
/**
 * lightwa's bundled WhatsApp web version. Hosts should prefer
 * `fetchLatestBaileysVersion()`/`fetchLatestWaWebVersion()` over hardcoding a
 * tuple: the middle field is thousands and an out-of-date value makes the
 * server drop the connection with `<failure reason="405">`.
 */
export declare const fetchLatestBaileysVersion: () => Promise<{
    version: [number, number, number];
    isLatest: boolean;
}>;
/**
 * Fetch the live web client revision from `web.whatsapp.com/sw.js` (mirrors
 * Baileys), falling back to lightwa's bundled version when offline.
 */
export declare const fetchLatestWaWebVersion: () => Promise<{
    version: [number, number, number];
    isLatest: boolean;
}>;
export interface BaileysSocketConfig {
    version?: [number, number, number];
    auth?: {
        creds: AuthenticationCreds;
        keys: SignalKeyStore;
    };
    browser?: [string, string, string];
    logger?: SocketConfig['logger'];
    printQRInTerminal?: boolean;
    connectTimeoutMs?: number;
    keepAliveIntervalMs?: number;
    defaultQueryTimeoutMs?: number;
    syncFullHistory?: boolean;
    markOnlineOnConnect?: boolean;
    pushName?: string;
    waWebSocketUrl?: string;
    [key: string]: unknown;
}
export declare const makeWASocket: (config?: BaileysSocketConfig) => WAClient;
export declare const useMultiFileAuthState: (folder: string) => Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
}>;
export declare const makeCacheableSignalKeyStore: (keys: SignalKeyStore, _logger?: SocketConfig["logger"]) => SignalKeyStore;
export interface PreparedMedia {
    url: string;
    directPath: string;
    mediaKey: Uint8Array;
    fileSha256: Uint8Array;
    fileEncSha256: Uint8Array;
    fileLength: number;
    mediaKeyTimestamp: number;
}
export declare const prepareWAMessageMedia: (message: Record<string, unknown>, options?: {
    upload?: (data: Buffer, opts: {
        mediaType: MediaType;
        fileEncSha256B64: string;
    }) => Promise<PreparedMedia>;
}) => Promise<Record<string, MediaMessage>>;
export declare const generateWAMessageContent: (content: Record<string, any>, options?: {
    upload?: (data: Buffer | Uint8Array, opts: {
        mediaType: MediaType;
        fileEncSha256B64: string;
    }) => Promise<PreparedMedia>;
}) => Promise<IMessage>;
export interface WAMessage {
    key: {
        remoteJid: string;
        fromMe: boolean;
        id: string;
        participant?: string;
    };
    message: IMessage;
    messageTimestamp: number;
    participant?: string;
    messageStubParameters: string[];
    status: WAMessageStatus;
}
export declare const generateWAMessageFromContent: (jid: string, message: IMessage, options?: {
    messageId?: string;
    timestamp?: Date;
    userJid?: string;
    quoted?: WAMessage;
    ephemeralExpiration?: number;
}) => WAMessage;
export declare const generateWAMessage: (jid: string, content: Record<string, any>, options?: {
    upload?: (data: Buffer | Uint8Array, opts: {
        mediaType: MediaType;
        fileEncSha256B64: string;
    }) => Promise<PreparedMedia>;
    userJid?: string;
    quoted?: WAMessage;
    messageId?: string;
    timestamp?: Date;
}) => Promise<WAMessage>;
export declare const downloadContentFromMessage: (content: {
    mediaKey: Uint8Array;
    directPath?: string;
    url?: string;
}, type: string, opts?: {
    host?: string;
}) => Promise<Readable>;
export declare const downloadMediaMessage: (message: {
    message?: IMessage;
} | IMessage, _type?: string, opts?: {
    host?: string;
}) => Promise<Buffer>;
export declare const getUrlInfo: (url: string) => Promise<{
    "canonical-url": string;
}>;
export default makeWASocket;
//# sourceMappingURL=baileys.d.ts.map