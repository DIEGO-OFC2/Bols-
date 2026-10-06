import WebSocket from 'ws';
import { initAuthState, initAuthCreds, type AuthenticationState } from '../utils/auth-utils.js';
import { type BrowserDescription } from '../utils/browser-utils.js';
import { Emitter } from '../utils/emitter.js';
import { SignalRepository } from '../signal/repository.js';
import { type IMessage } from '../proto/message.js';
import { type USyncProtocol, type USyncUserInput } from '../usync/index.js';
import { encryptMedia, type MediaType } from '../media/index.js';
export declare enum DisconnectReason {
    connectionClosed = 428,
    connectionLost = 408,
    connectionReplaced = 440,
    timedOut = 408,
    loggedOut = 401,
    badSession = 500,
    restartRequired = 515,
    multideviceMismatch = 411,
    forbidden = 403,
    unavailableService = 503,
    connectionFailure = 428
}
export interface SocketConfig {
    /** waWebSocketUrl */
    waWebSocketUrl?: string;
    /** HTTP origin used for the WebSocket upgrade */
    origin?: string;
    version?: [number, number, number];
    browser?: BrowserDescription;
    countryCode?: string;
    syncFullHistory?: boolean;
    pushName?: string;
    connectTimeoutMs?: number;
    keepAliveIntervalMs?: number;
    /** How long each QR stays live (ms). */
    qrTimeout?: number;
    auth?: AuthenticationState;
    logger?: Logger;
    /** Test hook: override the certificate authority key/serial. */
    noiseCertPublicKey?: Uint8Array;
    noiseCertSerial?: number;
    /** Called on every inbound message node so hosts can track presence. */
    onMessage?: (message: IncomingMessage) => void;
    /** Optional host cache consulted before issuing a group metadata query. */
    cachedGroupMetadata?: (jid: string) => Promise<GroupMetadata | undefined>;
}
export interface Logger {
    level: string;
    trace: (obj: unknown, msg: string) => void;
    debug: (obj: unknown, msg: string) => void;
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
}
export interface ConnectionUpdate {
    connection?: 'connecting' | 'open' | 'close';
    qr?: string;
    isNewLogin?: boolean;
    receivedPendingNotifications?: boolean;
    lastDisconnect?: {
        error?: Error;
        date: Date;
    };
}
type UserEvents = {
    'connection.update': (update: ConnectionUpdate) => void;
    'creds.update': (creds: unknown) => void;
    'messages.upsert': (payload: {
        messages: IncomingMessage[];
        type: string;
    }) => void;
    'groups.update': (updates: GroupMetadata[]) => void;
    'group-participants.update': (update: GroupParticipantsUpdate) => void;
};
export interface IncomingMessage {
    key: {
        remoteJid: string;
        fromMe: boolean;
        id: string;
        participant?: string;
    };
    message: IMessage;
    messageTimestamp: number;
    pushName?: string;
}
export interface Contact {
    id: string;
    name?: string;
    notify?: string;
    verifiedName?: string;
}
export interface Chat {
    id: string;
    name?: string;
    conversationTimestamp?: number;
    unreadCount?: number;
}
export interface GroupParticipant {
    id: string;
    admin?: 'admin' | 'superadmin' | null;
}
export interface GroupMetadata {
    id: string;
    subject: string;
    owner?: string;
    creation?: number;
    participants: GroupParticipant[];
    desc?: string;
    descId?: string;
    addressingMode?: string;
    size?: number;
}
export interface GroupParticipantsUpdate {
    id: string;
    author: string;
    participants: string[];
    action: 'add' | 'remove' | 'promote' | 'demote' | 'modify';
}
export type GroupParticipantAction = GroupParticipantsUpdate['action'];
export interface WAMessage {
    key: WAMessageKey;
    message: IMessage;
    messageTimestamp: number;
    participant?: string;
    messageStubParameters: string[];
    status: number;
}
export interface WAMessageKey {
    remoteJid: string;
    fromMe?: boolean;
    id: string;
    participant?: string;
}
export interface SendMessageOptions {
    quoted?: WAMessage;
    mentions?: string[];
    messageId?: string;
    /** Extra fields merged into the outgoing content's `contextInfo`. */
    contextInfo?: Record<string, any>;
}
export declare const DEFAULT_WA_VERSION: [number, number, number];
export declare class WAClient {
    readonly ev: Emitter<UserEvents>;
    readonly authState: AuthenticationState;
    readonly chats: Map<string, Chat>;
    readonly contacts: Record<string, Contact>;
    user?: {
        id: string;
        name?: string;
        lid?: string;
    };
    private _ws;
    private noise;
    /**
     * Resolves once the Noise transport keys are installed, i.e. `sendNode` can
     * emit a decryptable frame. Requests that need the transport (pairing code)
     * await this instead of racing the handshake.
     */
    private transportReady;
    private readonly config;
    private ephemeralKeyPair;
    private keepAliveTimer;
    private qrTimer;
    private lastDateRecv;
    private closed;
    private counter;
    private pendingResolvers;
    private handshakeResolver;
    private handshakeRejecter;
    private repo;
    private mediaConn;
    private privacySettings?;
    private groupMetaCache;
    private sentMessages;
    private receiptWaiters;
    private messageRetryCache;
    constructor(config?: SocketConfig);
    private get connectionConfig();
    getUser(): {
        id: string;
        name?: string;
        lid?: string;
    } | undefined;
    /** Incrementing 20-char message tag (matches the WA Web format). */
    private generateMessageTag;
    private sendRaw;
    private sendNode;
    private query;
    /** Execute a raw USync query; the device pipeline builds on this. */
    executeUSyncQuery(protocols: USyncProtocol[], users: USyncUserInput[], context?: string, mode?: string): Promise<Record<string, unknown>[]>;
    /** Connect and open the websocket. Handshake happens on the 'open' event. */
    connect(): void;
    private awaitNextMessage;
    private validateConnection;
    private startKeepAlive;
    private onMessageReceived;
    /**
     * Dispatch a decrypted frame. During the handshake `decodeFrame` yields the
     * raw (length-stripped) protobuf, which resolves the pending handshake wait.
     */
    private routeIncoming;
    private handleNode;
    private handleIb;
    private handlePairDevice;
    private handleCompanionReg;
    /**
     * Handle the phone's `primary_hello` notification: answer with
     * `companion_finish`, then ack. The server replies to the finish IQ and later
     * emits `pair-success`. Notifications that arrive without the pairing payload
     * are acked and ignored.
     */
    private handleCompanionRegNotification;
    private handlePairSuccess;
    private handleSuccess;
    private buildGroupMetadata;
    private handleGroupNotification;
    /** Lazily create the Signal repository once creds are usable. */
    private getRepository;
    private handlePreKeyUpload;
    private generateAndStorePreKeys;
    sendMessage(jid: string, content: IMessage | Record<string, any>, options?: SendMessageOptions): Promise<WAMessage>;
    private buildContent;
    private inlineContent;
    private mediaKind;
    private mediaType;
    private defaultMimetype;
    private toMediaBuffer;
    private applyContextInfo;
    private applyQuoted;
    private applyMentions;
    private sendBuiltMessage;
    /** Encrypt the message for one participant (its own devices, or the group). */
    private encryptForRecipients;
    /** Resolve the concrete device JIDs for a recipient or group. */
    private resolveRecipients;
    private getOwnDevices;
    /** Query device lists via USync and cache nothing (memory-frugal). */
    private getUSyncDevices;
    /**
     * Fetch pre-key bundles for devices with no session yet and inject them, so
     * the subsequent encrypt produces a `pkmsg`. Sessions are only keyed on the
     * wire id (LID when a mapping exists), matching the server's addressing.
     */
    private assertSessions;
    private extractPreKey;
    /** Map device JIDs to the LID form the server uses for the session fetch. */
    private toWireJids;
    private queryGroupMetadata;
    /** Encrypt + upload a media buffer, returning the fields a media message needs. */
    prepareMedia(data: Uint8Array, type: MediaType): Promise<{
        url: string;
        directPath: string;
        enc: ReturnType<typeof encryptMedia>;
    }>;
    /**
     * Baileys-compatible media upload entry point. Accepts the several shapes a
     * host may hand back — a Buffer, a `{ type: 'Buffer', data }` BufferJSON
     * object, a `{ stream }` async iterable, or a file path — and pushes the
     * (already encrypted) bytes to the media host.
     */
    waUploadToServer: (encrypted: unknown, opts: {
        mediaType: MediaType;
        fileEncSha256B64: string;
    }) => Promise<{
        url: string;
        mediaUrl: string;
        directPath: string;
    }>;
    sendImage(jid: string, image: Uint8Array, opts?: {
        caption?: string;
        mimetype?: string;
        fileName?: string;
    }): Promise<WAMessage>;
    sendMedia(jid: string, data: Uint8Array, type: MediaType, opts?: {
        caption?: string;
        mimetype?: string;
        fileName?: string;
        seconds?: number;
        ptt?: boolean;
        height?: number;
        width?: number;
    }): Promise<WAMessage>;
    private refreshMediaConn;
    private _mediaFetchDate;
    private handleIncomingMessage;
    private retryRequest;
    private decryptMessageNode;
    private sendMessageAck;
    private generateMessageId;
    private messageType;
    private buildDeviceIdentityNode;
    /** Ask the server for a pairing code for a phone number (linked-device flow). */
    requestPairingCode(phoneNumber: string, customPairingCode?: string): Promise<string>;
    /**
     * Wait until the Noise transport is usable. Rejects if the connection drops
     * (or was never started) before the handshake completes, so callers fail
     * fast instead of hanging on a socket that will never open.
     */
    private awaitTransport;
    private generatePairingKey;
    private end;
    get signalRepository(): SignalRepository;
    get ws(): WebSocket | null;
    groupMetadata(jid: string): Promise<GroupMetadata>;
    groupFetchAllParticipating(): Promise<Record<string, GroupMetadata>>;
    groupParticipantsUpdate(jid: string, participants: string[], action: GroupParticipantAction): Promise<{
        status: string;
        jid: string;
    }[]>;
    groupInviteCode(jid: string): Promise<string | undefined>;
    profilePictureUrl(jid: string, type?: 'preview' | 'image'): Promise<string | undefined>;
    sendPresenceUpdate(type: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused', to?: string): Promise<void>;
    sendReceipt(jid: string, participant: string | undefined, ids: string[], type: 'read' | 'read-self' | 'played' | 'delivered'): Promise<void>;
    /** Bulk send receipts, grouped by chat + participant, skipping our own messages. */
    sendReceipts(keys: WAMessageKey[], type: 'read' | 'read-self' | 'played' | 'delivered'): Promise<void>;
    /** Bulk read messages, honouring the account's read-receipt privacy setting. */
    readMessages(keys: WAMessageKey[]): Promise<void>;
    presenceSubscribe(toJid: string): Promise<void>;
    fetchPrivacySettings(force?: boolean): Promise<Record<string, string>>;
    fetchStatus(...jids: string[]): Promise<Record<string, unknown>[]>;
    onWhatsApp(...phoneNumbers: string[]): Promise<{
        jid: string;
        exists: boolean;
    }[]>;
    updateProfileStatus(status: string): Promise<void>;
    updateProfileName(name: string): Promise<void>;
    getBusinessProfile(jid: string): Promise<Record<string, unknown> | undefined>;
    /** Log out: tell the server to drop this companion, then close locally. */
    logout(msg?: string): Promise<void>;
    relayMessage(jid: string, message: IMessage, options?: SendMessageOptions): Promise<string>;
    /** Send a reaction (or clear one with an empty text) to a message. */
    sendReact(jid: string, emoji: string, key: WAMessage['key']): Promise<WAMessage>;
    /**
     * Send an album: one `albumMessage` envelope followed by each media child,
     * associated to the envelope via `messageContextInfo.messageAssociation`.
     * V3 implements this on top of the socket, but lightwa provides it natively
     * so the socket is a strict superset of what consumers expect.
     */
    sendAlbum(jid: string, medias: {
        type: 'image' | 'video';
        data: unknown;
    }[], options?: {
        caption?: string;
        quoted?: WAMessage;
    }): Promise<WAMessage>;
    downloadMediaMessage(message: WAMessage | IMessage, type?: string): Promise<Buffer>;
    close(): Promise<void>;
}
export { initAuthState, initAuthCreds };
export type { AuthenticationState };
//# sourceMappingURL=client.d.ts.map