/**
 * WhatsApp media handling: key derivation, AES-CBC encryption and the
 * media-connection upload endpoint.
 *
 * Thumbnails are intentionally optional: generating them needs an image codec
 * (sharp/jimp) which is a large dependency and a memory hog, so callers may
 * pass their own `jpegThumbnail` instead.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { hkdf } from '../crypto/index.js'

const ZERO32 = new Uint8Array(32)

export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'ptt' | 'gif'

export const MEDIA_PATH_MAP: Record<MediaType, string> = {
  image: '/mms/image',
  video: '/mms/video',
  audio: '/mms/audio',
  document: '/mms/document',
  sticker: '/mms/image',
  ptt: '/mms/audio',
  gif: '/mms/video'
}

const HKDF_NAME: Record<MediaType, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  sticker: 'Image',
  ptt: 'Audio',
  gif: 'Video'
}

// The info string is fixed per media type; precompute its UTF-8 bytes so the
// hot path does not allocate a Buffer on every key derivation.
const HKDF_INFO: Record<MediaType, Buffer> = Object.fromEntries(
  (Object.keys(HKDF_NAME) as MediaType[]).map(t => [t, Buffer.from(`WhatsApp ${HKDF_NAME[t]} Keys`)])
) as Record<MediaType, Buffer>

export interface MediaKeys {
  iv: Buffer
  cipherKey: Buffer
  macKey: Buffer
}

/** Derive the IV / cipher key / MAC key from a 32-byte media key. */
export const getMediaKeys = (mediaKey: Uint8Array, mediaType: MediaType): MediaKeys => {
  // HKDF-SHA256 with an all-zero salt, expanded to 112 bytes, is exactly
  // libsignal's deriveSecrets with 4 chunks.
  const expanded = hkdf(mediaKey, 112, { salt: ZERO32, info: HKDF_INFO[mediaType] })
  return {
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
    macKey: expanded.subarray(48, 80)
  }
}

export interface EncryptedMedia {
  mediaKey: Buffer
  fileSha256: Buffer
  fileEncSha256: Buffer
  fileLength: number
  /** ciphertext followed by the 10-byte MAC, i.e. the object to upload. */
  encrypted: Buffer
  mac: Buffer
}

/** Encrypt a whole media buffer. `plaintext` is not retained. */
export const encryptMedia = (plaintext: Uint8Array, mediaType: MediaType): EncryptedMedia => {
  const mediaKey = randomBytes(32)
  const { iv, cipherKey, macKey } = getMediaKeys(mediaKey, mediaType)

  const data = Buffer.from(plaintext)
  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv)
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()])

  const mac = createHmac('sha256', macKey).update(iv).update(ciphertext).digest().subarray(0, 10)
  const fileSha256 = createHash('sha256').update(data).digest()
  const fileEncSha256 = createHash('sha256').update(ciphertext).update(mac).digest()

  return {
    mediaKey,
    fileSha256,
    fileEncSha256,
    fileLength: data.length,
    encrypted: Buffer.concat([ciphertext, mac]),
    mac
  }
}

/** Decrypt a downloaded media object (ciphertext + MAC). */
export const decryptMedia = (encrypted: Uint8Array, mediaKey: Uint8Array, mediaType: MediaType): Buffer => {
  const { iv, cipherKey, macKey } = getMediaKeys(mediaKey, mediaType)
  const buf = Buffer.from(encrypted)
  const ciphertext = buf.subarray(0, buf.length - 10)
  const mac = buf.subarray(-10)
  const expected = createHmac('sha256', macKey).update(iv).update(ciphertext).digest().subarray(0, 10)
  if (!expected.equals(mac)) throw new Error('Media MAC mismatch')
  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export interface MediaConnInfo {
  hosts: { hostname: string; maxContentLengthBytes: number }[]
  auth: string
  ttl: number
  fetchDate: Date
}

export interface UploadResult {
  url: string
  directPath: string
}

/**
 * Upload an encrypted object with `node:https`. We deliberately avoid fetch so
 * the body is not copied into memory by undici.
 */
export const uploadToHost = (
  hostname: string,
  mediaPath: string,
  encSha256: Uint8Array,
  data: Buffer,
  auth: string
): Promise<UploadResult> =>
  new Promise((resolve, reject) => {
    const b64 = encodeURIComponent(Buffer.from(encSha256).toString('base64'))
    const path = `${mediaPath}/${b64}?auth=${encodeURIComponent(auth)}&token=${b64}`
    const req = httpsRequest(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Origin: 'https://web.whatsapp.com',
          'Content-Length': data.length
        }
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c as Buffer))
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (body.url && body.direct_path) resolve({ url: body.url, directPath: body.direct_path })
            else reject(new Error(`media upload failed: ${JSON.stringify(body)}`))
          } catch (e) {
            reject(e as Error)
          }
        })
      }
    )
    req.on('error', reject)
    req.end(data)
  })

/** Upload to the first working host, refreshing the connection on failure. */
export const uploadMedia = async (
  encrypted: Buffer,
  encSha256: Uint8Array,
  mediaType: MediaType,
  getConn: (force: boolean) => Promise<MediaConnInfo>
): Promise<UploadResult> => {
  let conn = await getConn(false)
  const path = MEDIA_PATH_MAP[mediaType]
  for (let attempt = 0; attempt <= conn.hosts.length; attempt++) {
    const host = conn.hosts[attempt % conn.hosts.length] ?? conn.hosts[0]
    if (!host) throw new Error('No media host available')
    try {
      return await uploadToHost(host.hostname, path, encSha256, encrypted, conn.auth)
    } catch (e) {
      if (attempt < conn.hosts.length) conn = await getConn(true)
    }
  }
  throw new Error('Media upload failed on all hosts')
}
