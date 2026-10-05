import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { WAClient, DisconnectReason } from '../socket/client.js';
import { initAuthCreds } from '../utils/auth-utils.js';
import { Browsers } from '../utils/browser-utils.js';
import { delay, unixTimestampSeconds } from '../utils/generics.js';
import { jidDecode, jidEncode, jidNormalizedUser, isJidGroup, isJidBroadcast, isPnUser, isLidUser } from '../wabinary/jid.js';
import { getContentType, normalizeMessageContent } from '../proto/message.js';
import { decryptMedia, encryptMedia } from '../media/index.js';
export { DisconnectReason, Browsers, delay, jidNormalizedUser, jidEncode, jidDecode, isJidGroup, isJidBroadcast, getContentType, normalizeMessageContent };
export const isJidUser = (jid) => isPnUser(jid) || isLidUser(jid);
export const areJidsSameUser = (a, b) => jidDecode(a)?.user === jidDecode(b)?.user;
export const getDevice = (jid) => jidDecode(jid)?.device;
export const extractMessageContent = normalizeMessageContent;
export var WAMessageStubType;
(function (WAMessageStubType) {
    WAMessageStubType[WAMessageStubType["UNKNOWN"] = 0] = "UNKNOWN";
    WAMessageStubType[WAMessageStubType["REVOKE"] = 1] = "REVOKE";
    WAMessageStubType[WAMessageStubType["CIPHERTEXT"] = 2] = "CIPHERTEXT";
    WAMessageStubType[WAMessageStubType["REVOKE_CIPHERTEXT"] = 3] = "REVOKE_CIPHERTEXT";
})(WAMessageStubType || (WAMessageStubType = {}));
export var WAMessageStatus;
(function (WAMessageStatus) {
    WAMessageStatus[WAMessageStatus["ERROR"] = 0] = "ERROR";
    WAMessageStatus[WAMessageStatus["PENDING"] = 1] = "PENDING";
    WAMessageStatus[WAMessageStatus["SERVER_ACK"] = 2] = "SERVER_ACK";
    WAMessageStatus[WAMessageStatus["DELIVERY_ACK"] = 3] = "DELIVERY_ACK";
    WAMessageStatus[WAMessageStatus["READ"] = 4] = "READ";
    WAMessageStatus[WAMessageStatus["PLAYED"] = 5] = "PLAYED";
})(WAMessageStatus || (WAMessageStatus = {}));
export const proto = {
    Message: {
        create: (message) => message
    }
};
export const DEFAULT_WA_VERSION = [2, 3000, 1043857760];
export const fetchLatestBaileysVersion = async () => ({
    version: DEFAULT_WA_VERSION,
    isLatest: true
});
export const fetchLatestWaWebVersion = fetchLatestBaileysVersion;
export const makeWASocket = (config = {}) => {
    const socketConfig = {
        version: config.version,
        browser: config.browser,
        logger: config.logger,
        connectTimeoutMs: config.connectTimeoutMs ?? config.defaultQueryTimeoutMs,
        keepAliveIntervalMs: config.keepAliveIntervalMs,
        syncFullHistory: config.syncFullHistory
    };
    if (config.auth)
        socketConfig.auth = { creds: config.auth.creds, keys: config.auth.keys };
    const sock = new WAClient(socketConfig);
    if (config.printQRInTerminal) {
        sock.ev.on('connection.update', async ({ qr }) => {
            if (!qr)
                return;
            try {
                const specifier = 'qrcode';
                const mod = await import(specifier);
                const QRCode = mod.default ?? mod;
                console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
            }
            catch {
                console.log(`QR: ${qr}`);
            }
        });
    }
    return sock;
};
const BufferJSON = {
    replacer: (_key, value) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
            const buf = Buffer.isBuffer(value) || value instanceof Uint8Array
                ? value
                : Buffer.from(value.data);
            return { type: 'Buffer', data: Buffer.from(buf).toString('base64') };
        }
        return value;
    },
    reviver: (_key, value) => {
        const v = value;
        if (v?.type === 'Buffer' && typeof v.data === 'string')
            return Buffer.from(v.data, 'base64');
        return value;
    }
};
const fixFileName = (file) => file.replace(/\//g, '__').replace(/:/g, '-');
export const useMultiFileAuthState = async (folder) => {
    const info = await stat(folder).catch(() => undefined);
    if (info && !info.isDirectory())
        throw new Error(`found something that is not a directory at ${folder}`);
    if (!info)
        await mkdir(folder, { recursive: true });
    const readData = async (file) => {
        try {
            return JSON.parse(await readFile(join(folder, fixFileName(file)), 'utf-8'), BufferJSON.reviver);
        }
        catch {
            return null;
        }
    };
    const writeData = async (data, file) => {
        await writeFile(join(folder, fixFileName(file)), JSON.stringify(data, BufferJSON.replacer));
    };
    const removeData = async (file) => {
        try {
            await unlink(join(folder, fixFileName(file)));
        }
        catch { }
    };
    const creds = (await readData('creds.json')) ?? initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        data[id] = await readData(`${type}-${id}.json`);
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            tasks.push(value ? writeData(value, `${category}-${id}.json`) : removeData(`${category}-${id}.json`));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => writeData(creds, 'creds.json')
    };
};
const CACHE_MAX = 512;
export const makeCacheableSignalKeyStore = (keys, _logger) => {
    const cache = new Map();
    const put = (key, value) => {
        if (cache.size >= CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined)
                cache.delete(oldest);
        }
        cache.set(key, value);
    };
    return {
        get: async (type, ids) => {
            const out = {};
            const missing = [];
            for (const id of ids) {
                const key = `${type}-${id}`;
                if (cache.has(key))
                    out[id] = cache.get(key);
                else
                    missing.push(id);
            }
            if (missing.length) {
                const fetched = await keys.get(type, missing);
                for (const id of missing) {
                    const value = fetched[id];
                    if (value !== undefined && value !== null)
                        put(`${type}-${id}`, value);
                    out[id] = value;
                }
            }
            return out;
        },
        set: async (data) => {
            for (const category of Object.keys(data)) {
                for (const id of Object.keys(data[category])) {
                    const key = `${category}-${id}`;
                    const value = data[category][id];
                    if (value === null)
                        cache.delete(key);
                    else
                        put(key, value);
                }
            }
            await keys.set(data);
        }
    };
};
const MEDIA_KIND = {
    image: 'image',
    video: 'video',
    audio: 'audio',
    document: 'document',
    sticker: 'sticker',
    ptt: 'ptt'
};
const fetchBuffer = async (url) => {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`failed to fetch ${url}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
};
const toBuffer = async (item) => {
    if (Buffer.isBuffer(item))
        return item;
    if (item instanceof Uint8Array)
        return Buffer.from(item);
    if (typeof item === 'string') {
        if (/^https?:\/\//.test(item))
            return fetchBuffer(item);
        return readFileSync(item);
    }
    const obj = item;
    if (obj?.stream) {
        const chunks = [];
        for await (const chunk of obj.stream)
            chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
    }
    if (obj?.url)
        return fetchBuffer(obj.url);
    throw new Error('unsupported media source');
};
const toU8 = (value) => {
    if (value === undefined || value === null)
        return undefined;
    if (value instanceof Uint8Array)
        return value;
    const v = value;
    if (v.type === 'Buffer' && Array.isArray(v.data))
        return Uint8Array.from(v.data);
    if (v.type === 'Buffer' && typeof v.data === 'string')
        return Buffer.from(v.data, 'base64');
    if (typeof value === 'string')
        return Buffer.from(value, 'base64');
    return undefined;
};
export const prepareWAMessageMedia = async (message, options = {}) => {
    let kind;
    for (const k of Object.keys(MEDIA_KIND)) {
        if (message[k] !== undefined)
            kind = k;
    }
    if (!kind)
        throw new Error('Invalid media type');
    const mediaType = MEDIA_KIND[kind];
    const source = message[kind];
    const buffer = await toBuffer(source);
    const enc = encryptMedia(buffer, mediaType);
    const mediaKey = enc.mediaKey;
    if (!options.upload)
        throw new Error('missing upload function');
    const uploadResult = await options.upload(enc.encrypted, {
        mediaType,
        fileEncSha256B64: Buffer.from(enc.fileEncSha256).toString('base64')
    });
    const fileSha256 = enc.fileSha256;
    const url = uploadResult.url;
    const directPath = uploadResult.directPath;
    const merged = { ...message };
    delete merged[kind];
    const mimetype = merged.mimetype ?? defaultMimetypeFor(mediaType);
    const media = {
        url,
        directPath,
        mimetype,
        fileSha256,
        fileEncSha256: enc.fileEncSha256,
        fileLength: buffer.length,
        mediaKey,
        mediaKeyTimestamp: unixTimestampSeconds(),
        caption: merged.caption,
        fileName: merged.fileName ?? (mediaType === 'document' ? 'file' : undefined),
        seconds: merged.seconds,
        ptt: mediaType === 'audio' ? (merged.ptt ?? false) : undefined,
        gifPlayback: merged.gifPlayback,
        viewOnce: merged.viewOnce,
        height: merged.height,
        width: merged.width,
        jpegThumbnail: toU8(merged.jpegThumbnail)
    };
    const mediaMessage = { [`${kind}Message`]: media };
    if (mediaType === 'image' && (merged.viewOnce || message.viewOnce)) {
        return { viewOnceMessageV2: { message: mediaMessage } };
    }
    return mediaMessage;
};
const defaultMimetypeFor = (mediaType) => {
    switch (mediaType) {
        case 'image':
            return 'image/jpeg';
        case 'video':
            return 'video/mp4';
        case 'audio':
        case 'ptt':
            return 'audio/ogg; codecs=opus';
        case 'sticker':
            return 'image/webp';
        default:
            return 'application/octet-stream';
    }
};
export const generateWAMessageContent = async (content, options = {}) => {
    if (content.text !== undefined)
        return { extendedTextMessage: { text: content.text } };
    if (content.react)
        return { reactionMessage: { key: content.react.key, text: content.react.text } };
    if (content.delete)
        return { protocolMessage: { key: content.delete, type: 0 } };
    const kind = Object.keys(MEDIA_KIND).find(k => content[k] !== undefined);
    if (kind) {
        if (!options.upload)
            throw new Error('missing upload for media message');
        const prepared = await prepareWAMessageMedia(content, { upload: options.upload });
        return prepared;
    }
    if (content.messageContextInfo || content.albumMessage)
        return content;
    throw new Error(`unsupported message content: ${Object.keys(content).join(',')}`);
};
const generateMessageIDV2 = (userId) => {
    const data = Buffer.alloc(8 + 20 + 16);
    data.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
    if (userId) {
        const id = jidDecode(userId);
        if (id?.user) {
            data.write(id.user, 8);
            data.write('@c.us', 8 + id.user.length);
        }
    }
    randomBytes(16).copy(data, 28);
    return '3EB0' + createHash('sha256').update(data).digest('hex').toUpperCase().substring(0, 18);
};
export const generateWAMessageFromContent = (jid, message, options = {}) => {
    const timestamp = unixTimestampSeconds(options.timestamp ?? new Date());
    const normalized = normalizeMessageContent(message) ?? message;
    let key = getContentType(normalized);
    let target = message;
    // `conversation` is a bare string on the wire and cannot carry contextInfo;
    // promote it to extendedTextMessage when a quote/expiry needs attaching.
    if (key === 'conversation' && (options.quoted || options.ephemeralExpiration)) {
        target = { extendedTextMessage: { text: message.conversation } };
        key = 'extendedTextMessage';
    }
    if (options.quoted && key) {
        const quoted = options.quoted;
        const participant = quoted.key.fromMe
            ? options.userJid
            : quoted.key.participant || quoted.key.remoteJid;
        const quotedMsg = normalizeMessageContent(quoted.message) ?? quoted.message;
        const content = target[key];
        if (content && typeof content === 'object') {
            content.contextInfo = {
                ...(content.contextInfo ?? {}),
                participant: jidNormalizedUser(participant),
                stanzaId: quoted.key.id,
                quotedMessage: quotedMsg
            };
            if (jid !== quoted.key.remoteJid)
                content.contextInfo.remoteJid = quoted.key.remoteJid;
        }
    }
    if (options.ephemeralExpiration && key && key !== 'protocolMessage') {
        const content = target[key];
        if (content && typeof content === 'object') {
            content.contextInfo = { ...(content.contextInfo ?? {}), expiration: options.ephemeralExpiration };
        }
    }
    return {
        key: { remoteJid: jid, fromMe: true, id: options.messageId ?? generateMessageIDV2(options.userJid) },
        message: target,
        messageTimestamp: timestamp,
        participant: isJidGroup(jid) ? options.userJid : undefined,
        messageStubParameters: [],
        status: WAMessageStatus.PENDING
    };
};
export const generateWAMessage = async (jid, content, options = {}) => generateWAMessageFromContent(jid, await generateWAMessageContent(content, options), options);
export const downloadContentFromMessage = async (content, type, opts = {}) => {
    const mediaType = type.replace(/Message$/, '');
    const mediaKey = toU8(content.mediaKey);
    const host = opts.host ?? 'mmg.whatsapp.net';
    const url = content.directPath ? `https://${host}${content.directPath}` : content.url;
    if (!url)
        throw new Error('No valid media URL or directPath present in message');
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`media download failed: ${res.status}`);
    const encrypted = Buffer.from(await res.arrayBuffer());
    const decrypted = decryptMedia(encrypted, mediaKey, mediaType);
    return Readable.from(decrypted);
};
export const downloadMediaMessage = async (message, _type, opts = {}) => {
    const content = 'message' in message ? message.message : message;
    const normalized = normalizeMessageContent(content) ?? content ?? {};
    const kind = getContentType(normalized);
    if (!kind || !kind.endsWith('Message'))
        throw new Error('no downloadable media in message');
    const media = normalized[kind];
    const stream = await downloadContentFromMessage(media, kind, opts);
    const chunks = [];
    for await (const chunk of stream)
        chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
};
export const getUrlInfo = async (url) => ({ 'canonical-url': url });
export default makeWASocket;
//# sourceMappingURL=baileys.js.map