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
  pageCount?: number
  viewOnce?: boolean
}

export interface SenderKeyDistributionMessage {
  groupId?: string
  axolotlSenderKeyDistributionMessage?: Uint8Array
}

export interface IMessage {
  conversation?: string
  extendedTextMessage?: { text: string; contextInfo?: ContextInfo }
  imageMessage?: MediaMessage
  videoMessage?: MediaMessage & { gifPlayback?: boolean }
  audioMessage?: MediaMessage
  documentMessage?: MediaMessage
  stickerMessage?: MediaMessage
  senderKeyDistributionMessage?: SenderKeyDistributionMessage
  deviceSentMessage?: { destinationJid: string; message: IMessage }
  messageContextInfo?: Record<string, never>
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
}

const MEDIA_FIELDS: Record<string, MediaFields> = {
  image: {
    url: 1, mimetype: 2, caption: 3, fileSha256: 4, fileLength: 5, height: 6, width: 7,
    mediaKey: 8, fileEncSha256: 9, directPath: 11, mediaKeyTimestamp: 12, jpegThumbnail: 16,
    contextInfo: 17, viewOnce: 25
  },
  video: {
    url: 1, mimetype: 2, fileSha256: 3, fileLength: 4, seconds: 5, mediaKey: 6, caption: 7,
    height: 9, width: 10, fileEncSha256: 11, directPath: 13, mediaKeyTimestamp: 14,
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
  if (msg.messageContextInfo) w.message(35, withWriter(() => {}))
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
    else r.skip(wire)
  }
  return m
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
        msg.videoMessage = readMedia(r.bytes(), 'video') as IMessage['videoMessage']
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
      default:
        r.skip(wire)
        break
    }
  }
  return msg
}
