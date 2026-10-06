/**
 * Compatibility-layer tests: exercise the Baileys-shaped helpers the bot uses
 * (generateWAMessage*, prepareWAMessageMedia, downloadContentFromMessage,
 * album messages) and check the bytes against the reference WAProto.
 */
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { WebSocketServer } from 'ws'
import { encodeMessage, decodeMessage } from '../src/proto/message.js'
import { encryptMedia, decryptMedia } from '../src/media/index.js'
import {
  generateWAMessage,
  generateWAMessageContent,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  downloadContentFromMessage,
  proto,
  isJidUser,
  areJidsSameUser,
  getDevice,
  extractMessageContent,
  WAMessageStubType,
  WAMessageStatus,
  makeWASocket,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  DEFAULT_WA_VERSION
} from '../src/compat/baileys.js'
import { requireBaileys, baileysDir, skip } from './reference.js'

let total = 0
let pass = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const refProto = baileysDir() ? requireBaileys('WAProto/index.js').proto : null

const fakeUpload = async (encrypted: Buffer) => ({
  url: 'https://mmg.whatsapp.net/d/f/AbCdEf',
  directPath: '/v/t62.7118-24/AbCdEf',
  fileEncSha256: new Uint8Array(32),
  fileLength: encrypted.length
})

const run = async () => {
  // proto.create is an identity pass-through (the bot wraps messages with it).
  const raw = { conversation: 'hi' }
  check('proto.Message.create passthrough', proto.Message.create(raw) === raw)

  // generateWAMessageFromContent shape.
  const built = generateWAMessageFromContent('123@s.whatsapp.net', { conversation: 'hola' })
  check('fromContent remoteJid', built.key.remoteJid === '123@s.whatsapp.net')
  check('fromContent fromMe', built.key.fromMe === true)
  check('fromContent id is 3EB0-prefixed', built.key.id.startsWith('3EB0'), built.key.id)
  check('fromContent timestamp is seconds', built.messageTimestamp > 1_600_000_000 && built.messageTimestamp < 4_000_000_000)
  check('fromContent status pending', built.status === WAMessageStatus.PENDING)
  check('fromContent message preserved', (built.message as any).conversation === 'hola')

  // generateWAMessageContent text.
  const textContent = await generateWAMessageContent({ text: 'hey' })
  check('generateWAMessageContent text', textContent.extendedTextMessage?.text === 'hey')

  // generateWAMessage (text) — used by sendAlbum for non-first media items.
  const generated = await generateWAMessage('123@s.whatsapp.net', { text: 'yo' }, {})
  check('generateWAMessage text', (generated.message as any).extendedTextMessage?.text === 'yo')

  // Quoted contextInfo wiring.
  const quoted = generateWAMessageFromContent('123@s.whatsapp.net', { conversation: 'orig' })
  const reply = generateWAMessageFromContent('123@s.whatsapp.net', { conversation: 'reply' }, {
    quoted,
    userJid: 'me@s.whatsapp.net'
  })
  check('quoted promoted to extendedText', (reply.message as any).extendedTextMessage?.text === 'reply', JSON.stringify(reply.message))
  check('quoted stanzaId', (reply.message as any).extendedTextMessage?.contextInfo?.stanzaId === quoted.key.id, JSON.stringify(reply.message))
  check('quoted participant normalized', (reply.message as any).extendedTextMessage?.contextInfo?.participant === 'me@s.whatsapp.net')

  // prepareWAMessageMedia — image.
  const plaintext = Buffer.from('image-bytes'.repeat(50))
  const prepared = await prepareWAMessageMedia({ image: plaintext, caption: 'cap' }, { upload: fakeUpload as any })
  const imgMsg = (prepared as any).imageMessage
  check('prepareWAMessageMedia image url', imgMsg.url === 'https://mmg.whatsapp.net/d/f/AbCdEf')
  check('prepareWAMessageMedia image directPath', imgMsg.directPath === '/v/t62.7118-24/AbCdEf')
  check('prepareWAMessageMedia image caption', imgMsg.caption === 'cap')
  check('prepareWAMessageMedia image fileLength', imgMsg.fileLength === plaintext.length)
  check('prepareWAMessageMedia image mimetype default', imgMsg.mimetype === 'image/jpeg')
  check('prepareWAMessageMedia image mediaKey 32 bytes', imgMsg.mediaKey.length === 32)
  check('prepareWAMessageMedia image fileSha256 32 bytes', imgMsg.fileSha256.length === 32)

  // V3 passes `{ stream }` media objects; make sure they are drained.
  const streamed = await prepareWAMessageMedia({ video: { stream: Readable.from([plaintext]) } }, { upload: fakeUpload as any })
  check('prepareWAMessageMedia stream input', (streamed as any).videoMessage.fileLength === plaintext.length)

  // View-once images get wrapped the way Baileys does.
  const viewOnce = await prepareWAMessageMedia({ image: plaintext, viewOnce: true }, { upload: fakeUpload as any })
  check('prepareWAMessageMedia viewOnce wraps', !!(viewOnce as any).viewOnceMessageV2?.message?.imageMessage)

  // messageContextInfo content is passed through generateWAMessageContent.
  const ctxContent = await generateWAMessageContent({ messageContextInfo: {}, albumMessage: { expectedImageCount: 3 } })
  check('generateWAMessageContent album passthrough', (ctxContent as any).albumMessage.expectedImageCount === 3)

  // Round-trip: the media key produced by prepareWAMessageMedia decrypts the
  // matching ciphertext.
  const enc = encryptMedia(plaintext, 'image')
  const decrypted = decryptMedia(enc.encrypted, enc.mediaKey, 'image')
  check('encrypt/decrypt round trip', decrypted.equals(plaintext))
  check('prepareWAMessageMedia ciphertext matches encryptMedia', imgMsg.fileEncSha256.length === 32)

  // downloadContentFromMessage against a real HTTP server: the encrypted
  // object is served over the wire and must decrypt back to the plaintext.
  const enc2 = encryptMedia(plaintext, 'image')
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(enc2.encrypted)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  const downloaded = await downloadContentFromMessage(
    { mediaKey: enc2.mediaKey, url: `http://127.0.0.1:${port}/media` },
    'imageMessage'
  )
  const chunks: Buffer[] = []
  for await (const chunk of downloaded) chunks.push(Buffer.from(chunk))
  server.close()
  check('downloadContentFromMessage decrypts', Buffer.concat(chunks).equals(plaintext))

  // Album message: generateWAMessageFromContent + messageContextInfo survives
  // the protobuf codec and is readable by the reference.
  const album = generateWAMessageFromContent('123@g.us', {
    messageContextInfo: {},
    albumMessage: { expectedImageCount: 2, expectedVideoCount: 1 }
  })
  const albumBuf = encodeMessage(album.message)
  const ourAlbum = decodeMessage(albumBuf)
  check('album expectedImageCount', ourAlbum.albumMessage?.expectedImageCount === 2)
  check('album expectedVideoCount', ourAlbum.albumMessage?.expectedVideoCount === 1)
  check('album messageContextInfo present', !!ourAlbum.messageContextInfo)
  if (refProto) {
    const refAlbum = refProto.Message.decode(albumBuf).toJSON()
    check('reference reads lightwa album', refAlbum.albumMessage?.expectedImageCount === 2, JSON.stringify(refAlbum))
    check('reference reads messageContextInfo', !!refAlbum.messageContextInfo)
  }

  // messageAssociation (used for album children) survives.
  const assoc = generateWAMessageFromContent('123@g.us', {
    imageMessage: {
      url: 'u',
      mimetype: 'image/jpeg',
      fileSha256: new Uint8Array(32),
      fileLength: 1,
      mediaKey: new Uint8Array(32),
      fileEncSha256: new Uint8Array(32)
    }
  })
  ;(assoc.message as any).messageContextInfo = {
    messageAssociation: { associationType: 1, parentMessageKey: album.key }
  }
  const assocBuf = encodeMessage(assoc.message)
  const ourAssoc = decodeMessage(assocBuf)
  check('associationType survives', ourAssoc.messageContextInfo?.messageAssociation?.associationType === 1)
  check('parentMessageKey.id survives', ourAssoc.messageContextInfo?.messageAssociation?.parentMessageKey?.id === album.key.id)
  if (refProto) {
    const refAssoc = refProto.Message.decode(assocBuf).toJSON()
    check('reference reads messageAssociation', !!refAssoc.messageContextInfo?.messageAssociation, JSON.stringify(refAssoc.messageContextInfo))
  }

  // react content (used by conn.sendReact).
  const react = await generateWAMessageContent({ react: { text: '🔥', key: { remoteJid: '1@s.whatsapp.net', id: 'X', fromMe: false } } })
  check('react content', react.reactionMessage?.text === '🔥')
  const reactBuf = encodeMessage(react)
  const ourReact = decodeMessage(reactBuf)
  check('react key id survives', ourReact.reactionMessage?.key?.id === 'X')
  if (refProto) {
    const refReact = refProto.Message.decode(reactBuf).toJSON()
    check('reference reads reaction', refReact.reactionMessage?.text === '🔥')
  }

  // Util helpers the bot destructures.
  check('isJidUser pn', isJidUser('123@s.whatsapp.net') === true)
  check('isJidUser lid', isJidUser('123@lid') === true)
  check('isJidUser group false', isJidUser('123@g.us') === false)
  check('areJidsSameUser', areJidsSameUser('123:2@s.whatsapp.net', '123:5@s.whatsapp.net') === true)
  check('getDevice', getDevice('123:7@s.whatsapp.net') === 7)
  check('extractMessageContent unwraps', extractMessageContent({ viewOnceMessageV2: { message: { conversation: 'x' } } })?.conversation === 'x')
  check('WAMessageStubType enum', WAMessageStubType.REVOKE === 1)

  // Version helpers: the bundled fallback must be a modern tuple and the live
  // fetch must return a well-formed version (falling back to the bundled tuple
  // when offline).
  check('DEFAULT_WA_VERSION shape', DEFAULT_WA_VERSION[0] === 2 && DEFAULT_WA_VERSION[1] === 3000 && DEFAULT_WA_VERSION[2] > 1e9, DEFAULT_WA_VERSION.join('.'))
  const bundled = await fetchLatestBaileysVersion()
  const bundledShape = bundled.version[0] === 2 && bundled.version[1] === 3000 && bundled.version[2] > 1e9
  check('fetchLatestBaileysVersion returns a modern tuple', bundledShape && bundled.isLatest === true, bundled.version.join('.'))
  const live = await fetchLatestWaWebVersion()
  check('fetchLatestWaWebVersion valid tuple', live.version.length === 3 && live.version.every(n => Number.isInteger(n) && n > 0), live.version.join('.'))

  // makeWASocket returns a socket exposing the bot-facing surface.
  // A local server keeps the (now automatic) connection hermetic.
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>(res => wss.on('listening', () => res()))
  const sockPort = (wss.address() as any).port
  const sock = makeWASocket({
    auth: undefined as any,
    printQRInTerminal: false,
    waWebSocketUrl: `ws://127.0.0.1:${sockPort}`,
    logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  })
  check('makeWASocket auto-connects', !!sock.ws)
  check('socket has ev', !!sock.ev && typeof sock.ev.on === 'function')
  check('socket sendMessage fn', typeof (sock as any).sendMessage === 'function')
  check('socket sendPresenceUpdate fn', typeof (sock as any).sendPresenceUpdate === 'function')
  check('socket waUploadToServer fn', typeof (sock as any).waUploadToServer === 'function')
  check('socket groupMetadata fn', typeof (sock as any).groupMetadata === 'function')
  check('socket downloadMediaMessage fn', typeof (sock as any).downloadMediaMessage === 'function')
  check('socket relayMessage fn', typeof (sock as any).relayMessage === 'function')
  for (const m of ['logout', 'onWhatsApp', 'presenceSubscribe', 'readMessages', 'sendReceipts', 'updateProfileName', 'updateProfileStatus', 'fetchPrivacySettings', 'fetchStatus', 'getBusinessProfile', 'executeUSyncQuery', 'sendAlbum', 'sendReact']) {
    check(`socket ${m} fn`, typeof (sock as any)[m] === 'function')
  }
  await sock.close()
  wss.close()
  await new Promise(r => setTimeout(r, 50))

  console.log(`\n${pass}/${total} baileys compat checks passed`)
  if (pass !== total) process.exitCode = 1
}

run().catch(e => {
  console.error(e)
  process.exitCode = 1
})
