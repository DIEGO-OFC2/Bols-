/**
 * Protobuf codec for the WhatsApp `Message` type, covering the content kinds
 * the client can send and receive: text, media (image/audio/video/document),
 * stickers, and the group sender-key distribution message. Field numbers match
 * WAProto exactly so the wire format is identical.
 *
 * Backed by the fast primitives in `bytes.ts`: one growable buffer per message,
 * no per-varint allocation, zero-copy views when decoding, and a small pool for
 * the nested sub-message writers.
 */
import { ByteWriter } from './bytes.js';
export interface ContextInfo {
    stanzaId?: string;
    participant?: string;
    quotedMessage?: IMessage;
    remoteJid?: string;
    mentionedJid?: string[];
    expiration?: number;
    isForwarded?: boolean;
    forwardingScore?: number;
}
export interface MediaMessage {
    url: string;
    mimetype: string;
    fileSha256: Uint8Array;
    fileLength: number;
    mediaKey: Uint8Array;
    fileEncSha256: Uint8Array;
    directPath: string;
    mediaKeyTimestamp: number;
    jpegThumbnail?: Uint8Array;
    contextInfo?: ContextInfo;
    caption?: string;
    height?: number;
    width?: number;
    seconds?: number;
    ptt?: boolean;
    fileName?: string;
    title?: string;
    pageCount?: number;
    viewOnce?: boolean;
    gifPlayback?: boolean;
}
export interface SenderKeyDistributionMessage {
    groupId?: string;
    axolotlSenderKeyDistributionMessage?: Uint8Array;
}
export interface MessageKey {
    remoteJid?: string;
    fromMe?: boolean;
    id?: string;
    participant?: string;
}
export interface ReactionMessage {
    key?: MessageKey;
    text?: string;
    groupingKey?: string;
    senderTimestampMs?: number;
}
export interface ProtocolMessage {
    key?: MessageKey;
    type?: number;
    ephemeralExpiration?: number;
    ephemeralSettingTimestamp?: number;
    editedMessage?: IMessage;
    timestampMs?: number;
}
export interface MessageAssociation {
    associationType?: number;
    parentMessageKey?: MessageKey;
    messageIndex?: number;
}
export interface MessageContextInfo {
    messageAssociation?: MessageAssociation;
}
export interface AlbumMessage {
    expectedImageCount?: number;
    expectedVideoCount?: number;
    contextInfo?: ContextInfo;
}
export interface FutureProofMessage {
    message: IMessage;
}
export interface IMessage {
    conversation?: string;
    extendedTextMessage?: {
        text: string;
        contextInfo?: ContextInfo;
    };
    imageMessage?: MediaMessage;
    videoMessage?: MediaMessage;
    audioMessage?: MediaMessage;
    documentMessage?: MediaMessage;
    stickerMessage?: MediaMessage;
    protocolMessage?: ProtocolMessage;
    reactionMessage?: ReactionMessage;
    albumMessage?: AlbumMessage;
    messageContextInfo?: MessageContextInfo;
    senderKeyDistributionMessage?: SenderKeyDistributionMessage;
    deviceSentMessage?: {
        destinationJid: string;
        message: IMessage;
    };
    ephemeralMessage?: FutureProofMessage;
    viewOnceMessage?: FutureProofMessage;
    viewOnceMessageV2?: FutureProofMessage;
    documentWithCaptionMessage?: FutureProofMessage;
}
export declare const writeMessage: (w: ByteWriter, msg: IMessage) => ByteWriter;
export declare const encodeMessage: (msg: IMessage) => Buffer;
declare const CONTENT_KEYS: readonly ["conversation", "extendedTextMessage", "imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage", "protocolMessage", "reactionMessage", "albumMessage", "senderKeyDistributionMessage", "deviceSentMessage"];
export declare const getContentType: (msg: IMessage | undefined) => (typeof CONTENT_KEYS)[number] | undefined;
export declare const normalizeMessageContent: (msg: IMessage | undefined) => IMessage | undefined;
export declare const decodeMessage: (buf: Uint8Array) => IMessage;
export {};
//# sourceMappingURL=message.d.ts.map