import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { WAClient, DisconnectReason, DEFAULT_WA_VERSION, type SocketConfig } from '../socket/client.js'
import { initAuthCreds, type AuthenticationCreds, type AuthenticationState, type SignalKeyStore } from '../utils/auth-utils.js'
import { Browsers } from '../utils/browser-utils.js'
import { delay, unixTimestampSeconds } from '../utils/generics.js'
import { jidDecode, jidEncode, jidNormalizedUser, isJidGroup, isJidBroadcast, isPnUser, isLidUser } from '../wabinary/jid.js'
import { getContentType, normalizeMessageContent, type IMessage, type MediaMessage } from '../proto/message.js'
import { decryptMedia, encryptMedia, type MediaType } from '../media/index.js'

export { DisconnectReason, Browsers, delay, jidNormalizedUser, jidEncode, jidDecode, isJidGroup, isJidBroadcast, getContentType, normalizeMessageContent }

export const isJidUser = (jid?: string): boolean => isPnUser(jid) || isLidUser(jid)
export const areJidsSameUser = (a?: string, b?: string): boolean => jidDecode(a)?.user === jidDecode(b)?.user
export const getDevice = (jid?: string): number | undefined => jidDecode(jid)?.device
export const extractMessageContent = normalizeMessageContent

export enum WAMessageStubType {
  UNKNOWN = 0,
  REVOKE = 1,
  CIPHERTEXT = 2,
  REVOKE_CIPHERTEXT = 3
}

export enum WAMessageStatus {
  ERROR = 0,
  PENDING = 1,
  SERVER_ACK = 2,
  DELIVERY_ACK = 3,
  READ = 4,
  PLAYED = 5
}

export const proto = {
  Message: {
    create: <T>(message: T): T => message
  }
}

export { DEFAULT_WA_VERSION }

/**
 * lightwa's bundled WhatsApp web version. Hosts should prefer
 * `fetchLatestBaileysVersion()`/`fetchLatestWaWebVersion()` over hardcoding a
 * tuple: the middle field is thousands and an out-of-date value makes the
 * server drop the connection with `<failure reason="405">`.
 */
export const fetchLatestBaileysVersion = async (): Promise<{ version: [number, number, number]; isLatest: boolean }> => ({
  version: DEFAULT_WA_VERSION,
  isLatest: true
})

/**
 * Fetch the live web client revision from `web.whatsapp.com/sw.js` (mirrors
 * Baileys), falling back to lightwa's bundled version when offline.
 */
export const fetchLatestWaWebVersion = async (): Promise<{ version: [number, number, number]; isLatest: boolean }> => {
  try {
    const response = await fetch('https://web.whatsapp.com/sw.js', {
      method: 'GET',
      headers: {
        'sec-fetch-site': 'none',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) throw new Error(`Failed to fetch sw.js: ${response.statusText}`)
    const match = (await response.text()).match(/\\?"client_revision\\?":\s*(\d+)/)
    if (!match?.[1]) throw new Error('Could not find client revision in sw.js')
    return { version: [2, 3000, +match[1]], isLatest: true }
  } catch {
    return { version: DEFAULT_WA_VERSION, isLatest: false }
  }
}

export interface BaileysSocketConfig {
  version?: [number, number, number]
  auth?: { creds: AuthenticationCreds; keys: SignalKeyStore }
  browser?: [string, string, string]
  logger?: SocketConfig['logger']
  printQRInTerminal?: boolean
  connectTimeoutMs?: number
  keepAliveIntervalMs?: number
  defaultQueryTimeoutMs?: number
  syncFullHistory?: boolean
  markOnlineOnConnect?: boolean
  waWebSocketUrl?: string
  [key: string]: unknown
}

export const makeWASocket = (config: BaileysSocketConfig = {}): WAClient => {
  const socketConfig: SocketConfig = {
    version: config.version,
    browser: config.browser,
    logger: config.logger,
    waWebSocketUrl: config.waWebSocketUrl,
    connectTimeoutMs: config.connectTimeoutMs ?? config.defaultQueryTimeoutMs,
    keepAliveIntervalMs: config.keepAliveIntervalMs,
    syncFullHistory: config.syncFullHistory
  }
  if (config.auth) socketConfig.auth = { creds: config.auth.creds, keys: config.auth.keys }
  const sock = new WAClient(socketConfig)
  // Baileys opens the websocket as part of `makeWASocket`; hosts (the V3 bot)
  // rely on this and never call `connect()` themselves.
  sock.connect()
  if (config.printQRInTerminal) {
    sock.ev.on('connection.update', async ({ qr }) => {
      if (!qr) return
      try {
        const specifier = 'qrcode'
        const mod: any = await import(specifier)
        const QRCode = mod.default ?? mod
        console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
      } catch {
        console.log(`QR: ${qr}`)
      }
    })
  }
  return sock
}

const BufferJSON = {
  replacer: (_key: string, value: unknown): unknown => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || (value as { type?: string })?.type === 'Buffer') {
      const buf =
        Buffer.isBuffer(value) || value instanceof Uint8Array
          ? value
          : Buffer.from((value as { data: number[] }).data)
      return { type: 'Buffer', data: Buffer.from(buf).toString('base64') }
    }
    return value
  },
  reviver: (_key: string, value: unknown): unknown => {
    const v = value as { type?: string; data?: string }
    if (v?.type === 'Buffer' && typeof v.data === 'string') return Buffer.from(v.data, 'base64')
    return value
  }
}

const fixFileName = (file: string): string => file.replace(/\//g, '__').replace(/:/g, '-')

export const useMultiFileAuthState = async (
  folder: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  const info = await stat(folder).catch(() => undefined)
  if (info && !info.isDirectory()) throw new Error(`found something that is not a directory at ${folder}`)
  if (!info) await mkdir(folder, { recursive: true })

  const readData = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(join(folder, fixFileName(file)), 'utf-8'), BufferJSON.reviver)
    } catch {
      return null
    }
  }
  const writeData = async (data: unknown, file: string): Promise<void> => {
    await writeFile(join(folder, fixFileName(file)), JSON.stringify(data, BufferJSON.replacer))
  }
  const removeData = async (file: string): Promise<void> => {
    try {
      await unlink(join(folder, fixFileName(file)))
    } catch {}
  }

  const creds = ((await readData('creds.json')) as AuthenticationCreds) ?? initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: Record<string, unknown> = {}
          await Promise.all(
            ids.map(async id => {
              data[id] = await readData(`${type}-${id}.json`)
            })
          )
          return data
        },
        set: async data => {
          const tasks: Promise<void>[] = []
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category]!)) {
              const value = data[category]![id]
              tasks.push(value ? writeData(value, `${category}-${id}.json`) : removeData(`${category}-${id}.json`))
            }
          }
          await Promise.all(tasks)
        }
      }
    },
    saveCreds: async () => writeData(creds, 'creds.json')
  }
}

const CACHE_MAX = 512

export const makeCacheableSignalKeyStore = (
  keys: SignalKeyStore,
  _logger?: SocketConfig['logger']
): SignalKeyStore => {
  const cache = new Map<string, unknown>()
  const put = (key: string, value: unknown): void => {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, value)
  }
  return {
    get: async (type, ids) => {
      const out: Record<string, unknown> = {}
      const missing: string[] = []
      for (const id of ids) {
        const key = `${type}-${id}`
        if (cache.has(key)) out[id] = cache.get(key)
        else missing.push(id)
      }
      if (missing.length) {
        const fetched = await keys.get(type, missing)
        for (const id of missing) {
          const value = fetched[id]
          if (value !== undefined && value !== null) put(`${type}-${id}`, value)
          out[id] = value
        }
      }
      return out
    },
    set: async data => {
      for (const category of Object.keys(data)) {
        for (const id of Object.keys(data[category]!)) {
          const key = `${category}-${id}`
          const value = data[category]![id]
          if (value === null) cache.delete(key)
          else put(key, value)
        }
      }
      await keys.set(data)
    }
  }
}

const MEDIA_KIND: Record<string, MediaType> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
  sticker: 'sticker',
  ptt: 'ptt'
}

const fetchBuffer = async (url: string): Promise<Buffer> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const toBuffer = async (item: unknown): Promise<Buffer> => {
  if (Buffer.isBuffer(item)) return item
  if (item instanceof Uint8Array) return Buffer.from(item)
  if (typeof item === 'string') {
    if (/^https?:\/\//.test(item)) return fetchBuffer(item)
    return readFileSync(item)
  }
  const obj = item as { stream?: AsyncIterable<Buffer>; url?: string }
  if (obj?.stream) {
    const chunks: Buffer[] = []
    for await (const chunk of obj.stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }
  if (obj?.url) return fetchBuffer(obj.url)
  throw new Error('unsupported media source')
}

const toU8 = (value: unknown): Uint8Array | undefined => {
  if (value === undefined || value === null) return undefined
  if (value instanceof Uint8Array) return value
  const v = value as { type?: string; data?: number[] | string }
  if (v.type === 'Buffer' && Array.isArray(v.data)) return Uint8Array.from(v.data)
  if (v.type === 'Buffer' && typeof v.data === 'string') return Buffer.from(v.data, 'base64')
  if (typeof value === 'string') return Buffer.from(value, 'base64')
  return undefined
}

export interface PreparedMedia {
  url: string
  directPath: string
  mediaKey: Uint8Array
  fileSha256: Uint8Array
  fileEncSha256: Uint8Array
  fileLength: number
  mediaKeyTimestamp: number
}

export const prepareWAMessageMedia = async (
  message: Record<string, unknown>,
  options: {
    upload?: (data: Buffer, opts: { mediaType: MediaType; fileEncSha256B64: string }) => Promise<PreparedMedia>
  } = {}
): Promise<Record<string, MediaMessage>> => {
  let kind: string | undefined
  for (const k of Object.keys(MEDIA_KIND)) {
    if (message[k] !== undefined) kind = k
  }
  if (!kind) throw new Error('Invalid media type')

  const mediaType = MEDIA_KIND[kind]!
  const source = message[kind]
  const buffer = await toBuffer(source)
  const enc = encryptMedia(buffer, mediaType)
  const mediaKey = enc.mediaKey

  if (!options.upload) throw new Error('missing upload function')
  const uploadResult = await options.upload(enc.encrypted, {
    mediaType,
    fileEncSha256B64: Buffer.from(enc.fileEncSha256).toString('base64')
  })

  const fileSha256 = enc.fileSha256
  const url = uploadResult.url
  const directPath = uploadResult.directPath

  const merged: Record<string, unknown> = { ...message }
  delete merged[kind]
  const mimetype = (merged.mimetype as string) ?? defaultMimetypeFor(mediaType)
  const media: MediaMessage = {
    url,
    directPath,
    mimetype,
    fileSha256,
    fileEncSha256: enc.fileEncSha256,
    fileLength: buffer.length,
    mediaKey,
    mediaKeyTimestamp: unixTimestampSeconds(),
    caption: merged.caption as string | undefined,
    fileName: (merged.fileName as string) ?? (mediaType === 'document' ? 'file' : undefined),
    seconds: merged.seconds as number | undefined,
    ptt: mediaType === 'audio' ? ((merged.ptt as boolean) ?? false) : undefined,
    gifPlayback: merged.gifPlayback as boolean | undefined,
    viewOnce: merged.viewOnce as boolean | undefined,
    height: merged.height as number | undefined,
    width: merged.width as number | undefined,
    jpegThumbnail: toU8(merged.jpegThumbnail)
  }
  const mediaMessage: Record<string, any> = { [`${kind}Message`]: media }
  if (mediaType === 'image' && (merged.viewOnce || message.viewOnce)) {
    return { viewOnceMessageV2: { message: mediaMessage } } as Record<string, any>
  }
  return mediaMessage as Record<string, MediaMessage>
}

const defaultMimetypeFor = (mediaType: MediaType): string => {
  switch (mediaType) {
    case 'image':
      return 'image/jpeg'
    case 'video':
      return 'video/mp4'
    case 'audio':
    case 'ptt':
      return 'audio/ogg; codecs=opus'
    case 'sticker':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

export const generateWAMessageContent = async (
  content: Record<string, any>,
  options: {
    upload?: (data: Buffer | Uint8Array, opts: { mediaType: MediaType; fileEncSha256B64: string }) => Promise<PreparedMedia>
  } = {}
): Promise<IMessage> => {
  if (content.text !== undefined) return { extendedTextMessage: { text: content.text } }
  if (content.react) return { reactionMessage: { key: content.react.key, text: content.react.text } }
  if (content.delete) return { protocolMessage: { key: content.delete, type: 0 } }
  const kind = Object.keys(MEDIA_KIND).find(k => content[k] !== undefined)
  if (kind) {
    if (!options.upload) throw new Error('missing upload for media message')
    const prepared = await prepareWAMessageMedia(content, { upload: options.upload as any })
    return prepared as unknown as IMessage
  }
  if (content.messageContextInfo || content.albumMessage) return content as IMessage
  throw new Error(`unsupported message content: ${Object.keys(content).join(',')}`)
}

export interface WAMessage {
  key: { remoteJid: string; fromMe: boolean; id: string; participant?: string }
  message: IMessage
  messageTimestamp: number
  participant?: string
  messageStubParameters: string[]
  status: WAMessageStatus
}

const generateMessageIDV2 = (userId?: string): string => {
  const data = Buffer.alloc(8 + 20 + 16)
  data.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)))
  if (userId) {
    const id = jidDecode(userId)
    if (id?.user) {
      data.write(id.user, 8)
      data.write('@c.us', 8 + id.user.length)
    }
  }
  randomBytes(16).copy(data, 28)
  return '3EB0' + createHash('sha256').update(data).digest('hex').toUpperCase().substring(0, 18)
}

export const generateWAMessageFromContent = (
  jid: string,
  message: IMessage,
  options: { messageId?: string; timestamp?: Date; userJid?: string; quoted?: WAMessage; ephemeralExpiration?: number } = {}
): WAMessage => {
  const timestamp = unixTimestampSeconds(options.timestamp ?? new Date())
  const normalized = normalizeMessageContent(message) ?? message
  let key = getContentType(normalized)
  let target: Record<string, any> = message as Record<string, any>

  // `conversation` is a bare string on the wire and cannot carry contextInfo;
  // promote it to extendedTextMessage when a quote/expiry needs attaching.
  if (key === 'conversation' && (options.quoted || options.ephemeralExpiration)) {
    target = { extendedTextMessage: { text: (message as Record<string, any>).conversation } }
    key = 'extendedTextMessage'
  }

  if (options.quoted && key) {
    const quoted = options.quoted
    const participant = quoted.key.fromMe
      ? options.userJid
      : quoted.key.participant || quoted.key.remoteJid
    const quotedMsg = normalizeMessageContent(quoted.message) ?? quoted.message
    const content = target[key]
    if (content && typeof content === 'object') {
      content.contextInfo = {
        ...(content.contextInfo ?? {}),
        participant: jidNormalizedUser(participant),
        stanzaId: quoted.key.id,
        quotedMessage: quotedMsg
      }
      if (jid !== quoted.key.remoteJid) content.contextInfo.remoteJid = quoted.key.remoteJid
    }
  }

  if (options.ephemeralExpiration && key && key !== 'protocolMessage') {
    const content = target[key]
    if (content && typeof content === 'object') {
      content.contextInfo = { ...(content.contextInfo ?? {}), expiration: options.ephemeralExpiration }
    }
  }

  return {
    key: { remoteJid: jid, fromMe: true, id: options.messageId ?? generateMessageIDV2(options.userJid) },
    message: target as IMessage,
    messageTimestamp: timestamp,
    participant: isJidGroup(jid) ? options.userJid : undefined,
    messageStubParameters: [],
    status: WAMessageStatus.PENDING
  }
}

export const generateWAMessage = async (
  jid: string,
  content: Record<string, any>,
  options: {
    upload?: (data: Buffer | Uint8Array, opts: { mediaType: MediaType; fileEncSha256B64: string }) => Promise<PreparedMedia>
    userJid?: string
    quoted?: WAMessage
    messageId?: string
    timestamp?: Date
  } = {}
): Promise<WAMessage> =>
  generateWAMessageFromContent(jid, await generateWAMessageContent(content, options), options)

export const downloadContentFromMessage = async (
  content: { mediaKey: Uint8Array; directPath?: string; url?: string },
  type: string,
  opts: { host?: string } = {}
): Promise<Readable> => {
  const mediaType = type.replace(/Message$/, '') as MediaType
  const mediaKey = toU8(content.mediaKey)!
  const host = opts.host ?? 'mmg.whatsapp.net'
  const url = content.directPath ? `https://${host}${content.directPath}` : content.url
  if (!url) throw new Error('No valid media URL or directPath present in message')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`media download failed: ${res.status}`)
  const encrypted = Buffer.from(await res.arrayBuffer())
  const decrypted = decryptMedia(encrypted, mediaKey, mediaType)
  return Readable.from(decrypted)
}

export const downloadMediaMessage = async (
  message: { message?: IMessage } | IMessage,
  _type?: string,
  opts: { host?: string } = {}
): Promise<Buffer> => {
  const content = 'message' in message ? (message as { message?: IMessage }).message : (message as IMessage)
  const normalized = normalizeMessageContent(content) ?? content ?? {}
  const kind = getContentType(normalized)
  if (!kind || !kind.endsWith('Message')) throw new Error('no downloadable media in message')
  const media = (normalized as Record<string, any>)[kind] as MediaMessage
  const stream = await downloadContentFromMessage(media, kind, opts)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export const getUrlInfo = async (url: string): Promise<{ 'canonical-url': string }> => ({ 'canonical-url': url })

export default makeWASocket
