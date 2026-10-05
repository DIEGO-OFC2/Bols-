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
import { ByteReader, ByteWriter, acquireWriter, releaseWriter } from './bytes.js'

export interface ContextInfo {
  stanzaId?: string
  participant?: string
  quotedMessage?: IMessage
  remoteJid?: string
  mentionedJid?: string[]
  expiration?: number
  isForwarded?: boolean
  forwardingScore?: number
}

export interface MediaMessage {
  url: string
  mimetype: string
  fileSha256: Uint8Array
  fileLength: number
  mediaKey: Uint8Array
  fileEncSha256: Uint8Array
  directPath: string
  mediaKeyTimestamp: number
  jpegThumbnail?: Uint8Array
  contextInfo?: ContextInfo
  caption?: string
  height?: number
  width?: number
  seconds?: number
  ptt?: boolean
  fileName?: string
  title?: string
  pageCount?: number
  viewOnce?: boolean
  gifPlayback?: boolean
}

export interface SenderKeyDistributionMessage {
  groupId?: string
  axolotlSenderKeyDistributionMessage?: Uint8Array
}

export interface MessageKey {
  remoteJid?: string
  fromMe?: boolean
  id?: string
  participant?: string
}

export interface ReactionMessage {
  key?: MessageKey
  text?: string
  groupingKey?: string
  senderTimestampMs?: number
}

export interface ProtocolMessage {
  key?: MessageKey
  type?: number
  ephemeralExpiration?: number
  ephemeralSettingTimestamp?: number
  editedMessage?: IMessage
  timestampMs?: number
}

export interface MessageAssociation {
  associationType?: number
  parentMessageKey?: MessageKey
  messageIndex?: number
}

export interface MessageContextInfo {
  messageAssociation?: MessageAssociation
}

export interface AlbumMessage {
  expectedImageCount?: number
  expectedVideoCount?: number
  contextInfo?: ContextInfo
}

export interface FutureProofMessage {
  message: IMessage
}

export interface IMessage {
  conversation?: string
  extendedTextMessage?: { text: string; contextInfo?: ContextInfo }
  imageMessage?: MediaMessage
  videoMessage?: MediaMessage
  audioMessage?: MediaMessage
  documentMessage?: MediaMessage
  stickerMessage?: MediaMessage
  protocolMessage?: ProtocolMessage
  reactionMessage?: ReactionMessage
  albumMessage?: AlbumMessage
  messageContextInfo?: MessageContextInfo
  senderKeyDistributionMessage?: SenderKeyDistributionMessage
  deviceSentMessage?: { destinationJid: string; message: IMessage }
  ephemeralMessage?: FutureProofMessage
  viewOnceMessage?: FutureProofMessage
  viewOnceMessageV2?: FutureProofMessage
  documentWithCaptionMessage?: FutureProofMessage
}

// ---------------------------------------------------------------------------
// Sub-encoders
// ---------------------------------------------------------------------------

const writeContextInfo = (w: ByteWriter, c: ContextInfo): ByteWriter => {
  w.string(1, c.stanzaId)
  w.string(2, c.participant)
  if (c.quotedMessage) {
    const q = acquireWriter()
    writeMessage(q, c.quotedMessage)
    w.message(3, q)
    releaseWriter(q)
  }
  w.string(4, c.remoteJid)
  if (c.mentionedJid) for (const jid of c.mentionedJid) w.string(15, jid)
  w.uint32(25, c.expiration)
  w.uint32(21, c.forwardingScore)
  w.bool(22, c.isForwarded)
  return w
}

const writeMedia = (w: ByteWriter, m: MediaMessage, kind: 'image' | 'audio' | 'video' | 'document' | 'sticker'): void => {
  // The field numbers differ per media type; see WAProto.
  const f = MEDIA_FIELDS[kind]
  w.string(f.url, m.url)
  w.string(f.mimetype, m.mimetype)
  if (kind === 'image' || kind === 'document') w.string(f.caption!, m.caption ?? '')
  if (kind === 'document') w.string(f.title!, '')
  if (kind === 'document') w.string(f.fileName!, m.fileName ?? '')
  if (kind === 'document') w.uint32(6, m.pageCount)
  w.bytes(f.fileSha256, m.fileSha256)
  w.uint64(f.fileLength, m.fileLength)
  w.uint32(f.height!, m.height)
  w.uint32(f.width!, m.width)
  w.uint32(f.seconds!, m.seconds)
  w.bytes(f.mediaKey, m.mediaKey)
  w.bytes(f.fileEncSha256, m.fileEncSha256)
  w.bool(f.ptt!, m.ptt)
  w.string(f.directPath, m.directPath)
  w.uint64(f.mediaKeyTimestamp, m.mediaKeyTimestamp)
  w.bytes(f.jpegThumbnail!, m.jpegThumbnail)
  if (f.contextInfo && m.contextInfo) {
    const c = acquireWriter()
    writeContextInfo(c, m.contextInfo)
    w.message(f.contextInfo, c)
    releaseWriter(c)
  }
  w.bool(f.viewOnce!, m.viewOnce)
  w.bool(f.gifPlayback!, m.gifPlayback)
}

interface MediaFields {
  url: number
  mimetype: number
  caption?: number
  title?: number
  fileName?: number
  fileSha256: number
  fileLength: number
  height?: number
  width?: number
  seconds?: number
  mediaKey: number
  fileEncSha256: number
  ptt?: number
  directPath: number
  mediaKeyTimestamp: number
  jpegThumbnail?: number
  contextInfo?: number
  viewOnce?: number
  gifPlayback?: number
}

const MEDIA_FIELDS: Record<string, MediaFields> = {
  image: {
    url: 1, mimetype: 2, caption: 3, fileSha256: 4, fileLength: 5, height: 6, width: 7,
    mediaKey: 8, fileEncSha256: 9, directPath: 11, mediaKeyTimestamp: 12, jpegThumbnail: 16,
    contextInfo: 17, viewOnce: 25
  },
  video: {
    url: 1, mimetype: 2, fileSha256: 3, fileLength: 4, seconds: 5, mediaKey: 6, caption: 7,
    gifPlayback: 8, height: 9, width: 10, fileEncSha256: 11, directPath: 13, mediaKeyTimestamp: 14,
    jpegThumbnail: 16, contextInfo: 17, viewOnce: 20
  },
  audio: {
    url: 1, mimetype: 2, fileSha256: 3, fileLength: 4, seconds: 5, ptt: 6, mediaKey: 7,
    fileEncSha256: 8, directPath: 9, mediaKeyTimestamp: 10, contextInfo: 17, viewOnce: 21
  },
  document: {
    url: 1, mimetype: 2, title: 3, fileSha256: 4, fileLength: 5, mediaKey: 7, fileName: 8,
    fileEncSha256: 9, directPath: 10, mediaKeyTimestamp: 11, jpegThumbnail: 16, contextInfo: 17,
    caption: 20
  },
  sticker: {
    url: 1, mimetype: 5, height: 6, width: 7, fileSha256: 2, fileLength: 9, mediaKey: 4,
    fileEncSha256: 3, directPath: 8, mediaKeyTimestamp: 10, contextInfo: 17
  }
}

const writeMessageKey = (w: ByteWriter, key: MessageKey): void => {
  w.string(1, key.remoteJid)
  w.bool(2, key.fromMe)
  w.string(3, key.id)
  w.string(4, key.participant)
}

const writeProtocolMessage = (w: ByteWriter, p: ProtocolMessage): void => {
  if (p.key) {
    const k = acquireWriter()
    writeMessageKey(k, p.key)
    w.message(1, k)
    releaseWriter(k)
  }
  w.uint32(2, p.type)
  w.uint32(4, p.ephemeralExpiration)
  w.uint64(5, p.ephemeralSettingTimestamp)
  if (p.editedMessage) writeFutureProof(w, 14, p.editedMessage)
  w.uint64(15, p.timestampMs)
}

const writeReactionMessage = (w: ByteWriter, r: ReactionMessage): void => {
  if (r.key) {
    const k = acquireWriter()
    writeMessageKey(k, r.key)
    w.message(1, k)
    releaseWriter(k)
  }
  w.string(2, r.text)
  w.string(3, r.groupingKey)
  w.int32(4, r.senderTimestampMs)
}

const writeMessageContextInfo = (w: ByteWriter, m: MessageContextInfo): void => {
  const a = m.messageAssociation
  if (!a) return
  const s = withWriter(x => {
    x.uint32(1, a.associationType)
    if (a.parentMessageKey) {
      const k = acquireWriter()
      writeMessageKey(k, a.parentMessageKey)
      x.message(2, k)
      releaseWriter(k)
    }
    x.int32(3, a.messageIndex)
  })
  w.message(10, s)
  releaseWriter(s)
}

const writeFutureProof = (w: ByteWriter, field: number, inner: IMessage): void => {
  const s = acquireWriter()
  writeMessage(s, inner)
  w.message(field, s)
  releaseWriter(s)
}

// ---------------------------------------------------------------------------
// Top-level message
// ---------------------------------------------------------------------------

const withWriter = (fn: (w: ByteWriter) => void): ByteWriter => {
  const w = acquireWriter()
  fn(w)
  return w
}

export const writeMessage = (w: ByteWriter, msg: IMessage): ByteWriter => {
  if (msg.conversation !== undefined) w.string(1, msg.conversation)
  if (msg.senderKeyDistributionMessage) {
    const sk = msg.senderKeyDistributionMessage
    const s = withWriter(x => {
      x.string(1, sk.groupId)
      x.bytes(2, sk.axolotlSenderKeyDistributionMessage)
    })
    w.message(2, s)
    releaseWriter(s)
  }
  if (msg.imageMessage) {
    const s = withWriter(x => writeMedia(x, msg.imageMessage!, 'image'))
    w.message(3, s)
    releaseWriter(s)
  }
  if (msg.extendedTextMessage) {
    const e = msg.extendedTextMessage
    const s = withWriter(x => {
      x.string(1, e.text)
      if (e.contextInfo) {
        const c = acquireWriter()
        writeContextInfo(c, e.contextInfo)
        x.message(17, c)
        releaseWriter(c)
      }
    })
    w.message(6, s)
    releaseWriter(s)
  }
  if (msg.documentMessage) {
    const s = withWriter(x => writeMedia(x, msg.documentMessage!, 'document'))
    w.message(7, s)
    releaseWriter(s)
  }
  if (msg.audioMessage) {
    const s = withWriter(x => writeMedia(x, msg.audioMessage!, 'audio'))
    w.message(8, s)
    releaseWriter(s)
  }
  if (msg.videoMessage) {
    const s = withWriter(x => writeMedia(x, msg.videoMessage!, 'video'))
    w.message(9, s)
    releaseWriter(s)
  }
  if (msg.protocolMessage) {
    const s = withWriter(x => writeProtocolMessage(x, msg.protocolMessage!))
    w.message(12, s)
    releaseWriter(s)
  }
  if (msg.stickerMessage) {
    const s = withWriter(x => writeMedia(x, msg.stickerMessage!, 'sticker'))
    w.message(26, s)
    releaseWriter(s)
  }
  if (msg.deviceSentMessage) {
    const d = msg.deviceSentMessage
    const s = withWriter(x => {
      x.string(1, d.destinationJid)
      const inner = acquireWriter()
      writeMessage(inner, d.message)
      x.message(2, inner)
      releaseWriter(inner)
    })
    w.message(31, s)
    releaseWriter(s)
  }
  if (msg.messageContextInfo) {
    const s = withWriter(x => writeMessageContextInfo(x, msg.messageContextInfo!))
    w.message(35, s)
    releaseWriter(s)
  }
  if (msg.ephemeralMessage) writeFutureProof(w, 40, msg.ephemeralMessage.message)
  if (msg.reactionMessage) {
    const s = withWriter(x => writeReactionMessage(x, msg.reactionMessage!))
    w.message(46, s)
    releaseWriter(s)
  }
  if (msg.viewOnceMessageV2) writeFutureProof(w, 55, msg.viewOnceMessageV2.message)
  if (msg.documentWithCaptionMessage) writeFutureProof(w, 53, msg.documentWithCaptionMessage.message)
  if (msg.albumMessage) {
    const s = withWriter(x => {
      x.uint32(2, msg.albumMessage!.expectedImageCount)
      x.uint32(3, msg.albumMessage!.expectedVideoCount)
      if (msg.albumMessage!.contextInfo) {
        const c = acquireWriter()
        writeContextInfo(c, msg.albumMessage!.contextInfo)
        x.message(17, c)
        releaseWriter(c)
      }
    })
    w.message(83, s)
    releaseWriter(s)
  }
  if (msg.viewOnceMessage) writeFutureProof(w, 37, msg.viewOnceMessage.message)
  return w
}

const encodeScratch = new ByteWriter(512)

export const encodeMessage = (msg: IMessage): Buffer => {
  // encodeMessage is synchronous and non-reentrant, so one reused writer is
  // safe and avoids a fresh allocation per call. `finish()` copies the bytes
  // out before the writer is touched again.
  encodeScratch.reset()
  writeMessage(encodeScratch, msg)
  return encodeScratch.finish()
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const EMPTY = new Uint8Array(0)

const readContextInfo = (buf: Uint8Array): ContextInfo => {
  const r = new ByteReader(buf)
  const c: ContextInfo = {}
  while (!r.done) {
    const key = r.key()
    const field = key >>> 3
    const wire = key & 7
    if (field === 1) c.stanzaId = r.string()
    else if (field === 2) c.participant = r.string()
    else if (field === 3) c.quotedMessage = decodeMessage(r.bytes())
    else if (field === 4) c.remoteJid = r.string()
    else if (field === 15) (c.mentionedJid ??= []).push(r.string())
    else if (field === 25) c.expiration = r.uint()
    else if (field === 21) c.forwardingScore = r.uint()
    else if (field === 22) c.isForwarded = r.uint() === 1
    else r.skip(wire)
  }
  return c
}

const readMedia = (buf: Uint8Array, kind: keyof typeof MEDIA_FIELDS): MediaMessage => {
  const f = MEDIA_FIELDS[kind]
  const r = new ByteReader(buf)
  const m: MediaMessage = {
    url: '', mimetype: '', fileSha256: EMPTY, fileLength: 0, mediaKey: EMPTY,
    fileEncSha256: EMPTY, directPath: '', mediaKeyTimestamp: 0
  }
  while (!r.done) {
    const key = r.key()
    const n = key >>> 3
    const wire = key & 7
    if (n === f.url) m.url = r.string()
    else if (n === f.mimetype) m.mimetype = r.string()
    else if (n === f.caption) m.caption = r.string()
    else if (n === f.fileName) m.fileName = r.string()
    else if (n === f.fileSha256) m.fileSha256 = r.bytes()
    else if (n === f.fileLength) m.fileLength = r.uint()
    else if (n === f.height) m.height = r.uint()
    else if (n === f.width) m.width = r.uint()
    else if (n === f.seconds) m.seconds = r.uint()
    else if (n === f.mediaKey) m.mediaKey = r.bytes()
    else if (n === f.fileEncSha256) m.fileEncSha256 = r.bytes()
    else if (n === f.ptt) m.ptt = r.uint() === 1
    else if (n === f.directPath) m.directPath = r.string()
    else if (n === f.mediaKeyTimestamp) m.mediaKeyTimestamp = r.uint()
    else if (n === f.jpegThumbnail) m.jpegThumbnail = r.bytes()
    else if (n === f.contextInfo) m.contextInfo = readContextInfo(r.bytes())
    else if (n === f.viewOnce) m.viewOnce = r.uint() === 1
    else if (n === f.gifPlayback) m.gifPlayback = r.uint() === 1
    else r.skip(wire)
  }
  return m
}

const readMessageKey = (r: ByteReader): MessageKey => {
  const k: MessageKey = {}
  while (!r.done) {
    const key = r.key()
    const n = key >>> 3
    if (n === 1) k.remoteJid = r.string()
    else if (n === 2) k.fromMe = r.uint() === 1
    else if (n === 3) k.id = r.string()
    else if (n === 4) k.participant = r.string()
    else r.skip(key & 7)
  }
  return k
}

const readProtocolMessage = (buf: Uint8Array): ProtocolMessage => {
  const r = new ByteReader(buf)
  const p: ProtocolMessage = {}
  while (!r.done) {
    const key = r.key()
    const n = key >>> 3
    if (n === 1) p.key = readMessageKey(new ByteReader(r.bytes()))
    else if (n === 2) p.type = r.uint()
    else if (n === 4) p.ephemeralExpiration = r.uint()
    else if (n === 5) p.ephemeralSettingTimestamp = r.uint()
    else if (n === 14) p.editedMessage = decodeMessage(r.bytes())
    else if (n === 15) p.timestampMs = r.uint()
    else r.skip(key & 7)
  }
  return p
}

const readReactionMessage = (buf: Uint8Array): ReactionMessage => {
  const r = new ByteReader(buf)
  const m: ReactionMessage = {}
  while (!r.done) {
    const key = r.key()
    const n = key >>> 3
    if (n === 1) m.key = readMessageKey(new ByteReader(r.bytes()))
    else if (n === 2) m.text = r.string()
    else if (n === 3) m.groupingKey = r.string()
    else if (n === 4) m.senderTimestampMs = r.uint()
    else r.skip(key & 7)
  }
  return m
}

const readMessageContextInfo = (buf: Uint8Array): MessageContextInfo => {
  const r = new ByteReader(buf)
  const m: MessageContextInfo = {}
  while (!r.done) {
    const key = r.key()
    const n = key >>> 3
    if (n === 10) {
      const a = new ByteReader(r.bytes())
      const assoc: MessageAssociation = {}
      while (!a.done) {
        const ak = a.key()
        const an = ak >>> 3
        if (an === 1) assoc.associationType = a.uint()
        else if (an === 2) assoc.parentMessageKey = readMessageKey(new ByteReader(a.bytes()))
        else if (an === 3) assoc.messageIndex = a.uint()
        else a.skip(ak & 7)
      }
      m.messageAssociation = assoc
    } else r.skip(key & 7)
  }
  return m
}

const readAlbumMessage = (buf: Uint8Array): AlbumMessage => {
  const r = new ByteReader(buf)
  const m: AlbumMessage = {}
  while (!r.done) {
    const key = r.key()
    const n = key >>> 3
    if (n === 2) m.expectedImageCount = r.uint()
    else if (n === 3) m.expectedVideoCount = r.uint()
    else if (n === 17) m.contextInfo = readContextInfo(r.bytes())
    else r.skip(key & 7)
  }
  return m
}

const CONTENT_KEYS = [
  'conversation',
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
  'protocolMessage',
  'reactionMessage',
  'albumMessage',
  'senderKeyDistributionMessage',
  'deviceSentMessage'
] as const

export const getContentType = (msg: IMessage | undefined): (typeof CONTENT_KEYS)[number] | undefined => {
  if (!msg) return undefined
  for (const key of CONTENT_KEYS) if (msg[key] !== undefined) return key
  return undefined
}

export const normalizeMessageContent = (msg: IMessage | undefined): IMessage | undefined => {
  let current = msg
  while (current) {
    const wrapped =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.documentWithCaptionMessage?.message
    if (!wrapped) break
    current = wrapped
  }
  return current
}

export const decodeMessage = (buf: Uint8Array): IMessage => {
  const r = new ByteReader(buf)
  const msg: IMessage = {}
  while (!r.done) {
    const key = r.key()
    const field = key >>> 3
    const wire = key & 7
    switch (field) {
      case 1:
        msg.conversation = r.string()
        break
      case 2: {
        const s = new ByteReader(r.bytes())
        const sk: SenderKeyDistributionMessage = {}
        while (!s.done) {
          const k = s.key()
          const n = k >>> 3
          if (n === 1) sk.groupId = s.string()
          else if (n === 2) sk.axolotlSenderKeyDistributionMessage = s.bytes()
          else s.skip(k & 7)
        }
        msg.senderKeyDistributionMessage = sk
        break
      }
      case 3:
        msg.imageMessage = readMedia(r.bytes(), 'image')
        break
      case 6: {
        const s = new ByteReader(r.bytes())
        const e: { text: string; contextInfo?: ContextInfo } = { text: '' }
        while (!s.done) {
          const k = s.key()
          const n = k >>> 3
          if (n === 1) e.text = s.string()
          else if (n === 17) e.contextInfo = readContextInfo(s.bytes())
          else s.skip(k & 7)
        }
        msg.extendedTextMessage = e
        break
      }
      case 7:
        msg.documentMessage = readMedia(r.bytes(), 'document')
        break
      case 8:
        msg.audioMessage = readMedia(r.bytes(), 'audio')
        break
      case 9:
        msg.videoMessage = readMedia(r.bytes(), 'video')
        break
      case 12:
        msg.protocolMessage = readProtocolMessage(r.bytes())
        break
      case 26:
        msg.stickerMessage = readMedia(r.bytes(), 'sticker')
        break
      case 31: {
        const s = new ByteReader(r.bytes())
        const d: { destinationJid: string; message: IMessage } = { destinationJid: '', message: {} }
        while (!s.done) {
          const k = s.key()
          const n = k >>> 3
          if (n === 1) d.destinationJid = s.string()
          else if (n === 2) d.message = decodeMessage(s.bytes())
          else s.skip(k & 7)
        }
        msg.deviceSentMessage = d
        break
      }
      case 35:
        msg.messageContextInfo = readMessageContextInfo(r.bytes())
        break
      case 37:
        msg.viewOnceMessage = { message: decodeMessage(r.bytes()) }
        break
      case 40:
        msg.ephemeralMessage = { message: decodeMessage(r.bytes()) }
        break
      case 46:
        msg.reactionMessage = readReactionMessage(r.bytes())
        break
      case 53:
        msg.documentWithCaptionMessage = { message: decodeMessage(r.bytes()) }
        break
      case 55:
        msg.viewOnceMessageV2 = { message: decodeMessage(r.bytes()) }
        break
      case 83:
        msg.albumMessage = readAlbumMessage(r.bytes())
        break
      default:
        r.skip(wire)
        break
    }
  }
  return msg
}
