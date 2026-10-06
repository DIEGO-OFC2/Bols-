import WebSocket from 'ws'
import { randomBytes } from 'node:crypto'
import { Curve, aesEncryptCTR, derivePairingCodeKey, generateSignalPubKey } from '../crypto/index.js'
import type { KeyPair } from '../crypto/index.js'
import { encodeBinaryNode } from '../wabinary/encode.js'
import { decodeBinaryNode } from '../wabinary/decode.js'
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildBuffer, getBinaryNodeChildUInt, getBinaryNodeChildString } from '../wabinary/generic-utils.js'
import { S_WHATSAPP_NET } from '../wabinary/jid.js'
import type { BinaryNode } from '../wabinary/types.js'
import { encodeHandshakeMessage, decodeHandshakeMessage } from '../proto/handshake.js'
import { encodeClientPayload } from '../proto/client-payload.js'
import { NoiseHandler, NOISE_WA_HEADER } from './noise-handler.js'
import { bytesToCrockford } from '../utils/generics.js'
import { buildAckStanza } from '../utils/stanza-ack.js'
import { initAuthState, initAuthCreds, type AuthenticationState } from '../utils/auth-utils.js'
import { buildCompanionFinish, configureSuccessfulPairing, generateLoginNode, generateRegistrationNode, type ConnectionConfig } from '../utils/validate-connection.js'
import { buildPairingQRData, getCompanionPlatformId } from '../utils/companion-utils.js'
import { Browsers, type BrowserDescription } from '../utils/browser-utils.js'
import { Emitter } from '../utils/emitter.js'
import { SignalRepository } from '../signal/repository.js'
import { encodeMessage, decodeMessage, normalizeMessageContent, getContentType, type IMessage, type MediaMessage } from '../proto/message.js'
import {
  buildUSyncDeviceQuery,
  parseUSyncDeviceResult,
  extractDeviceJids,
  deviceJid,
  buildUSyncQuery,
  parseUSyncResult,
  type USyncProtocol,
  type USyncUserInput,
  type USyncDeviceResult
} from '../usync/index.js'
import {
  encryptMedia,
  decryptMedia,
  uploadMedia,
  type MediaConnInfo,
  type MediaType
} from '../media/index.js'
import { encodeBigEndian, unixTimestampSeconds } from '../utils/generics.js'
import { jidDecode, jidNormalizedUser, isJidGroup, isJidBroadcast, isPnUser, isLidUser, isJidMetaAI, areJidsSameUser } from '../wabinary/jid.js'

export enum DisconnectReason {
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
  waWebSocketUrl?: string
  /** HTTP origin used for the WebSocket upgrade */
  origin?: string
  version?: [number, number, number]
  browser?: BrowserDescription
  countryCode?: string
  syncFullHistory?: boolean
  pushName?: string
  connectTimeoutMs?: number
  keepAliveIntervalMs?: number
  /** Send an `available` presence on connect (Baileys default: true). */
  markOnlineOnConnect?: boolean
  /** How long each QR stays live (ms). */
  qrTimeout?: number
  auth?: AuthenticationState
  logger?: Logger
  /** Test hook: override the certificate authority key/serial. */
  noiseCertPublicKey?: Uint8Array
  noiseCertSerial?: number
  /** Called on every inbound message node so hosts can track presence. */
  onMessage?: (message: IncomingMessage) => void
  /** Optional host cache consulted before issuing a group metadata query. */
  cachedGroupMetadata?: (jid: string) => Promise<GroupMetadata | undefined>
}

export interface Logger {
  level: string
  trace: (obj: unknown, msg: string) => void
  debug: (obj: unknown, msg: string) => void
  info: (obj: unknown, msg: string) => void
  warn: (obj: unknown, msg: string) => void
  error: (obj: unknown, msg: string) => void
}

const silentLogger: Logger = {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

export interface ConnectionUpdate {
  connection?: 'connecting' | 'open' | 'close'
  qr?: string
  isNewLogin?: boolean
  receivedPendingNotifications?: boolean
  isOnline?: boolean
  lastDisconnect?: { error?: Error; date: Date }
}

type UserEvents = {
  'connection.update': (update: ConnectionUpdate) => void
  'creds.update': (creds: unknown) => void
  'messages.upsert': (payload: { messages: IncomingMessage[]; type: string }) => void
  'groups.update': (updates: GroupMetadata[]) => void
  'group-participants.update': (update: GroupParticipantsUpdate) => void
}

export interface IncomingMessage {
  key: {
    remoteJid: string
    remoteJidAlt?: string
    remoteJidUsername?: string
    fromMe: boolean
    id: string
    participant?: string
    participantAlt?: string
    participantUsername?: string
  }
  message: IMessage
  messageTimestamp: number
  pushName?: string
}

export interface Contact {
  id: string
  name?: string
  notify?: string
  verifiedName?: string
}

export interface Chat {
  id: string
  name?: string
  conversationTimestamp?: number
  unreadCount?: number
}

export interface GroupParticipant {
  id: string
  admin?: 'admin' | 'superadmin' | null
}

export interface GroupMetadata {
  id: string
  subject: string
  owner?: string
  creation?: number
  participants: GroupParticipant[]
  desc?: string
  descId?: string
  addressingMode?: string
  size?: number
}

export interface GroupParticipantsUpdate {
  id: string
  author: string
  participants: string[]
  action: 'add' | 'remove' | 'promote' | 'demote' | 'modify'
}

export type GroupParticipantAction = GroupParticipantsUpdate['action']

export interface WAMessage {
  key: WAMessageKey
  message: IMessage
  messageTimestamp: number
  participant?: string
  messageStubParameters: string[]
  status: number
}

export interface WAMessageKey {
  remoteJid: string
  remoteJidAlt?: string
  remoteJidUsername?: string
  fromMe?: boolean
  id: string
  participant?: string
  participantAlt?: string
  participantUsername?: string
}

export interface SendMessageOptions {
  quoted?: WAMessage
  mentions?: string[]
  messageId?: string
  /** Extra fields merged into the outgoing content's `contextInfo`. */
  contextInfo?: Record<string, any>
}

/**
 * lightwa's bundled WhatsApp web version, used when the live revision cannot be
 * fetched. Update this when the server starts rejecting the tuple (a stale
 * version makes the server answer `<failure reason="405">` before the
 * handshake). Prefer `fetchLatestWaWebVersion()` at runtime.
 */
export const DEFAULT_WA_VERSION: [number, number, number] = [2, 3000, 1049395099]
const DEFAULT_URL = 'wss://web.whatsapp.com/ws/chat'
const DEFAULT_ORIGIN = 'https://web.whatsapp.com'
const MAX_QR_REFS = 5
// Mirrors Baileys: one-time pre-keys are replenished in batches, with a larger
// initial batch when the server holds none for us yet.
const MIN_PREKEY_COUNT = 5
const INITIAL_PREKEY_COUNT = 812

/** Normalize the assorted media shapes a host may pass to `waUploadToServer`. */
const toUploadBuffer = async (input: unknown): Promise<Buffer> => {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input)
  if (typeof input === 'string') {
    const { readFile } = await import('node:fs/promises')
    return readFile(input)
  }
  const obj = input as {
    type?: string
    data?: number[] | string
    stream?: AsyncIterable<Uint8Array>
    url?: string
  }
  if (obj?.type === 'Buffer') {
    if (Array.isArray(obj.data)) return Buffer.from(obj.data)
    if (typeof obj.data === 'string') return Buffer.from(obj.data, 'base64')
  }
  if (obj?.stream) {
    const chunks: Buffer[] = []
    for await (const chunk of obj.stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }
  if (obj?.url) {
    const res = await fetch(obj.url)
    if (!res.ok) throw new Error(`failed to fetch media: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Error('unsupported media source for waUploadToServer')
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: Error) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Mark the rejection as handled so a gate nobody awaits (e.g. the QR flow)
  // cannot crash the host process with an unhandled rejection. Awaiters still
  // observe the rejection through `promise`.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * Resolve the alternate-addressing counterpart of a stanza, mirroring Baileys'
 * `extractAddressingContext`. WhatsApp addresses a growing share of chats by an
 * opaque LID; hosts (and lightwa's own `fromMe` detection) still need the
 * phone-number form, so the stanza carries `sender_pn`/`sender_lid` and
 * `recipient_pn`/`recipient_lid`. Without surfacing these, a LID-addressed
 * message has no resolvable phone number and hosts that resolve identities
 * (admin/owner checks, reply routing) silently mis-handle it.
 */
const extractAddressingContext = (
  stanza: BinaryNode
): { addressingMode: string; senderAlt?: string; recipientAlt?: string } => {
  const sender = stanza.attrs.participant || stanza.attrs.from
  const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn')
  let senderAlt: string | undefined
  let recipientAlt: string | undefined
  if (addressingMode === 'lid') {
    senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn
    recipientAlt = stanza.attrs.recipient_pn
  } else {
    senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid
    recipientAlt = stanza.attrs.recipient_lid
  }
  return { addressingMode, senderAlt, recipientAlt }
}

export class WAClient {
  readonly ev = new Emitter<UserEvents>()
  readonly authState: AuthenticationState
  readonly chats = new Map<string, Chat>()
  readonly contacts: Record<string, Contact> = {}

  user?: { id: string; name?: string; lid?: string }

  private _ws: WebSocket | null = null
  private noise: NoiseHandler | null = null
  /**
   * Resolves once the Noise transport keys are installed, i.e. `sendNode` can
   * emit a decryptable frame. Requests that need the transport (pairing code)
   * await this instead of racing the handshake.
   */
  private transportReady: Deferred<void> | null = null
  private readonly config: Required<Pick<SocketConfig, 'waWebSocketUrl' | 'origin' | 'version' | 'browser' | 'connectTimeoutMs' | 'keepAliveIntervalMs' | 'qrTimeout' | 'markOnlineOnConnect'>> & {
    countryCode: string
    syncFullHistory: boolean
    pushName?: string
    logger: Logger
    noiseCertPublicKey?: Uint8Array
    noiseCertSerial?: number
    onMessage?: (message: IncomingMessage) => void
    cachedGroupMetadata?: (jid: string) => Promise<GroupMetadata | undefined>
  }
  private ephemeralKeyPair: KeyPair | null = null
  private keepAliveTimer: NodeJS.Timeout | null = null
  private qrTimer: NodeJS.Timeout | null = null
  private lastDateRecv = Date.now()
  private closed = false
  private counter = 0
  private pendingResolvers = new Map<string, { resolve: (node: BinaryNode) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>()
  private handshakeResolver: ((data: Uint8Array) => void) | null = null
  private handshakeRejecter: ((err: Error) => void) | null = null
  private repo: SignalRepository | null = null
  private mediaConn: Promise<MediaConnInfo> | undefined
  private privacySettings?: Record<string, string>
  private groupMetaCache = new Map<string, GroupMetadata>()
  private sentMessages = new Map<string, IMessage>()
  private receiptWaiters = new Map<string, (node: BinaryNode) => void>()
  private messageRetryCache = new Map<string, number>()
  /** De-dupes concurrent pre-key uploads (server can request while one is in flight). */
  private preKeyUpload: Promise<void> | null = null

  constructor(config: SocketConfig = {}) {
    this.authState = config.auth ?? initAuthState()
    this.config = {
      waWebSocketUrl: config.waWebSocketUrl ?? DEFAULT_URL,
      origin: config.origin ?? DEFAULT_ORIGIN,
      version: config.version ?? DEFAULT_WA_VERSION,
      browser: config.browser ?? Browsers.macOS('Chrome'),
      connectTimeoutMs: config.connectTimeoutMs ?? 20_000,
      keepAliveIntervalMs: config.keepAliveIntervalMs ?? 30_000,
      markOnlineOnConnect: config.markOnlineOnConnect ?? true,
      qrTimeout: config.qrTimeout ?? 60_000,
      countryCode: config.countryCode ?? 'US',
      syncFullHistory: config.syncFullHistory ?? true,
      pushName: config.pushName,
      logger: config.logger ?? silentLogger,
      noiseCertPublicKey: config.noiseCertPublicKey,
      noiseCertSerial: config.noiseCertSerial,
      onMessage: config.onMessage,
      cachedGroupMetadata: config.cachedGroupMetadata
    }
  }

  private get connectionConfig(): ConnectionConfig {
    return {
      version: this.config.version,
      browser: this.config.browser,
      countryCode: this.config.countryCode,
      syncFullHistory: this.config.syncFullHistory,
      pushName: this.config.pushName
    }
  }

  getUser() {
    return this.authState.creds.me
  }
  /** Incrementing 20-char message tag (matches the WA Web format). */
  private generateMessageTag(): string {
    this.counter = (this.counter + 1) % 0xffff
    const ts = (Date.now() % 0x100000000).toString(16).padStart(8, '0')
    const c = this.counter.toString(16).padStart(4, '0')
    return `${ts}${c}00000000000000`.slice(0, 20)
  }

  private async sendRaw(data: Buffer): Promise<void> {
    const ws = this._ws
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Connection Closed')
    await new Promise<void>((resolve, reject) => {
      ws.send(data, err => (err ? reject(err) : resolve()))
    })
  }

  private async sendNode(node: BinaryNode): Promise<void> {
    if (!this.noise) throw new Error('noise not initialised')
    await this.sendRaw(this.noise.encodeFrame(encodeBinaryNode(node)))
  }

  private async query(node: BinaryNode): Promise<BinaryNode> {
    const id = node.attrs.id ?? this.generateMessageTag()
    node.attrs.id = id
    // A lost response must not leave the awaiter and its timer alive forever.
    const promise = new Promise<BinaryNode>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResolvers.delete(id)
        reject(new Error(`Query ${id} timed out`))
      }, this.config.connectTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pendingResolvers.set(id, { resolve, reject, timer })
    })
    await this.sendNode(node)
    return promise
  }

  /** Execute a raw USync query; the device pipeline builds on this. */
  async executeUSyncQuery(
    protocols: USyncProtocol[],
    users: USyncUserInput[],
    context = 'interactive',
    mode = 'query'
  ): Promise<Record<string, unknown>[]> {
    if (protocols.length === 0) throw new Error('USyncQuery must have at least one protocol')
    const result = await this.query(buildUSyncQuery(protocols, users, context, mode, this.generateMessageTag()))
    return parseUSyncResult(result, protocols)
  }

  /** Connect and open the websocket. Handshake happens on the 'open' event. */
  connect(): void {
    if (this._ws) return
    this.closed = false

    this.ephemeralKeyPair = Curve.generateKeyPair()
    this.noise = new NoiseHandler({
      keyPair: this.ephemeralKeyPair,
      logger: this.config.logger,
      certPublicKey: this.config.noiseCertPublicKey,
      certSerial: this.config.noiseCertSerial
    })
    // Reset the transport gate for this connection attempt.
    this.transportReady = deferred<void>()

    this.ev.emit('connection.update', { connection: 'connecting', qr: undefined })

    const ws = new WebSocket(this.config.waWebSocketUrl, {
      origin: this.config.origin,
      handshakeTimeout: this.config.connectTimeoutMs,
      timeout: this.config.connectTimeoutMs
    })
    this._ws = ws
    ws.setMaxListeners(0)

    ws.on('open', () => {
      void this.validateConnection().catch(err => void this.end(err as Error))
    })
    ws.on('message', (data: WebSocket.RawData) => {
      this.lastDateRecv = Date.now()
      // A malformed frame must not surface as an unhandled rejection (which
      // would crash the host process); end the connection instead.
      this.onMessageReceived(data).catch(err => void this.end(err as Error))
    })
    ws.on('error', err => void this.end(err as Error).catch(() => {}))
    ws.on('close', (code: number) =>
      void this.end(new Error(`Connection Terminated (${code})`), code).catch(() => {})
    )
  }

  private async awaitNextMessage(sendMsg?: Buffer): Promise<Uint8Array> {
    const ws = this._ws
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Connection Closed')

    return new Promise<Uint8Array>((resolve, reject) => {
      this.handshakeResolver = resolve
      this.handshakeRejecter = reject
      if (sendMsg) this.sendRaw(sendMsg).catch(reject)
    })
  }

  private async validateConnection(): Promise<void> {
    const noise = this.noise!
    const clientHello = encodeHandshakeMessage({ clientHello: { ephemeral: this.ephemeralKeyPair!.public } })

    // `awaitNextMessage` and the send both pass through encodeFrame/decodeFrame,
    // matching the reference framing exactly.
    const result = await this.awaitNextMessage(noise.encodeFrame(clientHello))
    const handshake = decodeHandshakeMessage(result)

    const keyEnc = noise.processHandshake(handshake, this.authState.creds.noiseKey)

    const creds = this.authState.creds
    const payload = creds.me
      ? generateLoginNode(creds.me.id, this.connectionConfig)
      : generateRegistrationNode(creds, this.connectionConfig)

    const payloadEnc = noise.encrypt(encodeClientPayload(payload))
    const clientFinish = encodeHandshakeMessage({ clientFinish: { static: keyEnc, payload: payloadEnc } })
    await this.sendRaw(noise.encodeFrame(clientFinish))
    await noise.finishInit(frame => this.routeIncoming(frame))
    this.transportReady?.resolve()
    this.startKeepAlive()
  }

  private startKeepAlive(): void {
    this.lastDateRecv = Date.now()
    this.keepAliveTimer = setInterval(() => {
      const diff = Date.now() - this.lastDateRecv
      if (diff > this.config.keepAliveIntervalMs + 5000) {
        void this.end(new Error('Connection was lost'))
      } else if (this._ws?.readyState === WebSocket.OPEN) {
        this.query({
          tag: 'iq',
          attrs: { id: this.generateMessageTag(), to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' },
          content: [{ tag: 'ping', attrs: {} }]
        }).catch(() => {})
      }
    }, this.config.keepAliveIntervalMs)
  }

  private async onMessageReceived(data: WebSocket.RawData): Promise<void> {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    await this.noise?.decodeFrame(buf, frame => this.routeIncoming(frame))
  }

  /**
   * Dispatch a decrypted frame. During the handshake `decodeFrame` yields the
   * raw (length-stripped) protobuf, which resolves the pending handshake wait.
   */
  private routeIncoming(frame: BinaryNode | Uint8Array): void {
    if (frame instanceof Uint8Array) {
      if (this.handshakeResolver) {
        const resolve = this.handshakeResolver
        this.handshakeResolver = null
        this.handshakeRejecter = null
        resolve(frame)
        return
      }
      this.handleNode(decodeBinaryNode(Buffer.isBuffer(frame) ? frame : Buffer.from(frame)))
      return
    }
    this.handleNode(frame)
  }

  private handleNode(node: BinaryNode): void {
    const { tag, attrs } = node
    const id = attrs.id

    if (id && this.pendingResolvers.has(id)) {
      const pending = this.pendingResolvers.get(id)!
      this.pendingResolvers.delete(id)
      clearTimeout(pending.timer)
      pending.resolve(node)
    }

    this.config.logger.trace({ tag, id }, 'recv frame')

    // <iq type="set" ...><pair-device>...</pair-device></iq>
    if (tag === 'iq' && attrs.type === 'set') {
      const pairDevice = getBinaryNodeChild(node, 'pair-device')
      if (pairDevice) return void this.handlePairDevice(node, pairDevice)
    }

    if (tag === 'iq' && getBinaryNodeChild(node, 'pair-success')) {
      return void this.handlePairSuccess(node)
    }

    if (tag === 'link_code_companion_reg') {
      return void this.handleCompanionReg(node)
    }

    if (tag === 'success') return void this.handleSuccess(node)

    if (tag === 'failure') {
      const statusCode = Number(attrs.reason) || DisconnectReason.badSession
      return void this.end(new Error('Connection Failure'), statusCode)
    }

    if (tag === 'xmlstreamend') {
      return void this.end(new Error('Connection Terminated by Server'), DisconnectReason.connectionClosed)
    }

    if (tag === 'stream:error') {
      const children = Array.isArray(node.content) ? (node.content as BinaryNode[]) : []
      const reason = children[0]?.tag
      const mapped = reason === 'conflict' ? DisconnectReason.connectionReplaced : undefined
      const statusCode = Number(attrs.code) || mapped || DisconnectReason.badSession
      return void this.end(new Error(`Stream Errored (${reason ?? 'unknown'})`), statusCode)
    }

    // Pre-key upload can be requested as an IQ set with xmlns="encrypt".
    if (tag === 'iq' && attrs.type === 'set' && attrs.xmlns === 'encrypt') {
      return void this.handlePreKeyUpload()
    }

    if (tag === 'message') {
      return void this.handleIncomingMessage(node)
    }

    if (tag === 'receipt') {
      const id = attrs.id
      if (id) {
        const waiter = this.receiptWaiters.get(id)
        if (waiter) waiter(node)
      }
      return
    }

    if (tag === 'notification') {
      if (attrs.type === 'w:gp2') {
        this.handleGroupNotification(node)
        return void this.ackStanza(node)
      }
      // The phone triggers the second pairing leg with a `primary_hello`
      // notification once the user enters the code. Without handling it the
      // companion never sends `companion_finish` and no `pair-success` arrives.
      if (attrs.type === 'link_code_companion_reg') return void this.handleCompanionRegNotification(node)
      // Server asks for more one-time pre-keys when its supply runs low. This
      // is the *real* trigger (not an encrypt IQ): ignoring it starves the
      // server of pre-keys and peers can no longer open sessions to us, so the
      // socket connects and saves but silently receives nothing.
      if (attrs.type === 'encrypt') return void this.handleEncryptNotification(node)
      // Every notification must be acked, even the ones we do not act on;
      // WA Web does the same. An unacked notification stays in the server's
      // delivery queue.
      return void this.ackStanza(node)
    }

    // Server-driven "information" stanzas. Most are informational, but
    // `offline_preview` must be answered with an `offline_batch` request or the
    // server never pushes the pending/offline messages, and
    // `downgrade_webclient` means multi-device is not joined.
    if (tag === 'ib') return void this.handleIb(node)

    if (tag === 'chatstate' || tag === 'presence') return
  }

  private handleIb(node: BinaryNode): void {
    const children = Array.isArray(node.content) ? (node.content as BinaryNode[]) : []
    const child = children[0]
    switch (child?.tag) {
      case 'offline_preview':
        // Ask the server to flush the queued offline messages; it then streams
        // them followed by an <ib><offline count=..></ib> marker.
        void this.sendNode({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_batch', attrs: { count: '100' } }] }).catch(() => {})
        return
      case 'edge_routing': {
        const routingInfo = getBinaryNodeChild(child, 'routing_info')
        if (routingInfo?.content) this.authState.creds.routingInfo = Buffer.from(routingInfo.content as Uint8Array)
        return
      }
      case 'offline':
        this.ev.emit('connection.update', { receivedPendingNotifications: true })
        return
      case 'downgrade_webclient':
        void this.end(new Error('Multi-device beta not joined'), DisconnectReason.multideviceMismatch)
        return
      default:
        // Unknown server info stanza (e.g. `dirty`): ack it so it is not
        // redelivered. Guarded on id/from inside `ackStanza`.
        void this.ackStanza(node)
        return
    }
  }

  private handlePairDevice(stanza: BinaryNode, pairDevice: BinaryNode): void {
    const refNodes = getBinaryNodeChildren(pairDevice, 'ref')
    const creds = this.authState.creds
    const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64')
    const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64')
    const advB64 = creds.advSecretKey

    void this.sendNode({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'result', id: stanza.attrs.id! } })

    let qrMs = this.config.qrTimeout
    const genPairQR = () => {
      if (this._ws?.readyState !== WebSocket.OPEN) return
      const refNode = refNodes.shift()
      if (!refNode) return void this.end(new Error('QR refs attempts ended'))
      const ref = (refNode.content as Buffer).toString('utf-8')
      const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, this.config.browser)
      this.ev.emit('connection.update', { qr })
      this.qrTimer = setTimeout(genPairQR, qrMs)
      qrMs = 20_000
    }
    genPairQR()
  }

  private async handleCompanionReg(stanza: BinaryNode): Promise<void> {
    try {
      const creds = this.authState.creds
      const { node, advSecretKey } = await buildCompanionFinish(
        stanza,
        creds,
        creds.me!.id,
        this.generateMessageTag()
      )
      creds.advSecretKey = advSecretKey
      creds.registered = true
      this.ev.emit('creds.update', creds)
      await this.sendNode(node)
    } catch (err) {
      void this.end(err as Error)
    }
  }

  /**
   * Handle the phone's `primary_hello` notification: answer with
   * `companion_finish`, then ack. The server replies to the finish IQ and later
   * emits `pair-success`. Notifications that arrive without the pairing payload
   * are acked and ignored.
   */
  private async handleCompanionRegNotification(node: BinaryNode): Promise<void> {
    try {
      const reg = getBinaryNodeChild(node, 'link_code_companion_reg')
      const hasPayload =
        !!reg &&
        !!getBinaryNodeChild(reg, 'link_code_pairing_ref') &&
        !!getBinaryNodeChild(reg, 'primary_identity_pub') &&
        !!getBinaryNodeChild(reg, 'link_code_pairing_wrapped_primary_ephemeral_pub')
      if (hasPayload) await this.handleCompanionReg(reg!)
    } finally {
      void this.ackStanza(node)
    }
  }

  private async handlePairSuccess(stanza: BinaryNode): Promise<void> {
    try {
      const { reply, creds } = configureSuccessfulPairing(stanza, this.authState.creds as any)
      Object.assign(this.authState.creds, creds)
      this.ev.emit('creds.update', creds)
      this.ev.emit('connection.update', { isNewLogin: true, qr: undefined })
      await this.sendNode(reply)
    } catch (err) {
      void this.end(err as Error)
    }
  }

  private handleSuccess(node: BinaryNode): void {
    if (this.qrTimer) clearTimeout(this.qrTimer)
    const me = this.authState.creds.me
    if (node.attrs.lid && me) {
      me.lid = node.attrs.lid
      // Baileys emits this so hosts that persist on `creds.update` keep our own
      // LID across restarts; without it the LID is lost and `areJidsSameUser`
      // can no longer recognise self-echoes / LID-addressed stanzas.
      this.ev.emit('creds.update', { me: { ...me, lid: node.attrs.lid } })
    }
    this.user = me ? { id: me.id, name: me.name, lid: me.lid } : undefined
    // Login goes out with `passive: true` (see `generateLoginNode`), which makes
    // the server hold back the message stream. Baileys flips to active right
    // after `success`; without it the socket stays connected but stops receiving
    // anything after the initial burst.
    void this.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, xmlns: 'passive', type: 'set' },
      content: [{ tag: 'active', attrs: {} }]
    }).catch(() => {})
    // A companion session starts with no one-time pre-keys on the server, so
    // nobody can open a Signal session to send us messages until we upload
    // some. Baileys does this on every `success`; skipping it is why the bot
    // connects, saves the session, and then silently receives nothing.
    void this.uploadPreKeysIfRequired().catch(() => {})
    // Mirror Baileys: mark the companion online right after login. Without it
    // the linked device stays "inactive" on the phone and some servers hold
    // back the message stream.
    if (this.config.markOnlineOnConnect) {
      void this.sendPresenceUpdate('available').catch(() => {})
    }
    this.ev.emit('connection.update', { connection: 'open' })
  }

  private buildGroupMetadata(node: BinaryNode): GroupMetadata {
    const attrs = node.attrs
    const participants: GroupParticipant[] = []
    const participantNodes = getBinaryNodeChildren(getBinaryNodeChild(node, 'participants'), 'participant')
    for (const p of participantNodes) {
      const id = p.attrs.jid
      if (!id) continue
      participants.push({ id, admin: (p.attrs.type as GroupParticipant['admin']) ?? null })
    }
    return {
      id: attrs.id ?? '',
      subject: attrs.subject ?? '',
      owner: attrs.creator,
      creation: attrs.creation ? +attrs.creation : undefined,
      desc: getBinaryNodeChildString(node, 'description') ?? undefined,
      descId: getBinaryNodeChild(getBinaryNodeChild(node, 'description'), 'body')?.attrs?.id,
      addressingMode: attrs.addressing_mode,
      size: participants.length,
      participants
    }
  }

  private handleGroupNotification(node: BinaryNode): void {
    const attrs = node.attrs
    if (!attrs.from || !isJidGroup(attrs.from)) return
    const participants: string[] = []
    const action = (attrs.type ?? 'modify') as GroupParticipantsUpdate['action']
    for (const p of getBinaryNodeChildren(node, 'participant')) {
      if (p.attrs.jid) participants.push(p.attrs.jid)
    }
    const author = (attrs.participant ?? attrs.from) as string
    this.groupMetaCache.delete(attrs.from)
    this.ev.emit('group-participants.update', { id: attrs.from, author, participants, action })
  }

  // -------------------------------------------------------------------------
  // Signal / keys
  // -------------------------------------------------------------------------

  /** Lazily create the Signal repository once creds are usable. */
  private getRepository(): SignalRepository {
    if (!this.repo) {
      this.repo = new SignalRepository(this.authState, {
        debug: (o, m) => this.config.logger.debug(o, m),
        warn: (o, m) => this.config.logger.warn(o, m)
      })
    }
    return this.repo
  }

  private async handlePreKeyUpload(): Promise<void> {
    await this.uploadPreKeys().catch(err => void this.end(err as Error))
  }

  /**
   * Server notification (`<notification type="encrypt"><count value=..>) telling
   * us its one-time pre-key supply is low. Upload more, then ack the stanza.
   */
  private async handleEncryptNotification(node: BinaryNode): Promise<void> {
    try {
      if (node.attrs.from === S_WHATSAPP_NET) {
        const count = +(getBinaryNodeChild(node, 'count')?.attrs.value ?? '0')
        if (count < MIN_PREKEY_COUNT) await this.uploadPreKeys(MIN_PREKEY_COUNT)
      }
    } catch (err) {
      this.config.logger.warn({ err }, 'failed to handle encrypt notification')
    } finally {
      void this.ackStanza(node)
    }
  }

  /** Ask the server how many one-time pre-keys it still holds for us. */
  private async getAvailablePreKeysOnServer(): Promise<number> {
    const result = await this.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'encrypt' },
      content: [{ tag: 'count', attrs: {} }]
    })
    return +(getBinaryNodeChild(result, 'count')?.attrs.value ?? '0')
  }

  /** Replenish pre-keys when the server's supply is low or our current key is missing. */
  private async uploadPreKeysIfRequired(): Promise<void> {
    const preKeyCount = await this.getAvailablePreKeysOnServer()
    const count = preKeyCount === 0 ? INITIAL_PREKEY_COUNT : MIN_PREKEY_COUNT
    const currentPreKeyId = this.authState.creds.nextPreKeyId - 1
    let currentPreKeyExists = false
    if (currentPreKeyId > 0) {
      const stored = await this.authState.keys.get('pre-key', [currentPreKeyId.toString()])
      currentPreKeyExists = Boolean(stored[currentPreKeyId.toString()])
    }
    const missingCurrentPreKey = !currentPreKeyExists && currentPreKeyId > 0
    if (preKeyCount <= count || missingCurrentPreKey) await this.uploadPreKeys(count)
  }

  private async uploadPreKeys(count = MIN_PREKEY_COUNT): Promise<void> {
    if (this.preKeyUpload) return this.preKeyUpload
    this.preKeyUpload = this.performPreKeyUpload(count).finally(() => {
      this.preKeyUpload = null
    })
    return this.preKeyUpload
  }

  private async performPreKeyUpload(count: number): Promise<void> {
    const creds = this.authState.creds
    const keys = await this.generateAndStorePreKeys(count)
    const content: BinaryNode[] = [
      { tag: 'registration', attrs: {}, content: encodeBigEndian(creds.registrationId) },
      { tag: 'type', attrs: {}, content: Buffer.from([5]) },
      { tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
      {
        tag: 'list',
        attrs: {},
        content: keys.map(({ id, keyPair }) => ({
          tag: 'key',
          attrs: {},
          content: [
            { tag: 'id', attrs: {}, content: encodeBigEndian(id, 3) },
            { tag: 'value', attrs: {}, content: keyPair.public }
          ]
        }))
      },
      {
        tag: 'skey',
        attrs: {},
        content: [
          { tag: 'id', attrs: {}, content: encodeBigEndian(creds.signedPreKey.keyId, 3) },
          { tag: 'value', attrs: {}, content: creds.signedPreKey.keyPair.public },
          { tag: 'signature', attrs: {}, content: creds.signedPreKey.signature }
        ]
      }
    ]
    await this.sendNode({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'encrypt' }, content })
    this.ev.emit('creds.update', creds)
  }

  private async generateAndStorePreKeys(count: number): Promise<{ id: number; keyPair: KeyPair }[]> {
    const creds = this.authState.creds
    const start = creds.nextPreKeyId
    const keys: { id: number; keyPair: KeyPair }[] = []
    const batch: Record<string, KeyPair> = {}
    for (let i = 0; i < count; i++) {
      const id = start + i
      const keyPair = Curve.generateKeyPair()
      batch[id] = keyPair
      keys.push({ id, keyPair })
    }
    creds.nextPreKeyId = start + count
    creds.firstUnuploadedPreKeyId = start + count
    await this.authState.keys.set({ 'pre-key': batch as any })
    return keys
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  async sendMessage(jid: string, content: IMessage | Record<string, any>, options: SendMessageOptions = {}): Promise<WAMessage> {
    const me = this.authState.creds.me
    if (!me) throw new Error('Not authenticated')
    const message = await this.buildContent(jid, content, options)
    if (options.contextInfo) this.applyContextInfo(message, options.contextInfo)
    if (options.quoted) this.applyQuoted(message, options.quoted, jid)
    if (options.mentions?.length) this.applyMentions(message, options.mentions)
    return this.sendBuiltMessage(jid, message, options.messageId)
  }

  private async buildContent(jid: string, content: IMessage | Record<string, any>, options: SendMessageOptions): Promise<IMessage> {
    const direct = getContentType(content as IMessage)
    if (direct && !('text' in content) && !('react' in content) && !('delete' in content)) return content as IMessage

    const c = content as Record<string, any>
    if (c.react) return { reactionMessage: { key: c.react.key, text: c.react.text } }
    if (c.delete) return { protocolMessage: { key: c.delete, type: 0 } }
    if (c.edit) {
      const original = this.sentMessages.get(c.edit.id)
      const edited: IMessage = original
        ? { ...(normalizeMessageContent(original) ?? original), ...this.inlineContent(c) }
        : this.inlineContent(c)
      return { protocolMessage: { key: c.edit, type: 14, editedMessage: edited } }
    }
    if (c.text !== undefined) return { extendedTextMessage: { text: c.text } }

    const kind = this.mediaKind(c)
    if (kind) {
      const data = await this.toMediaBuffer(c[kind])
      const prepared = await this.prepareMedia(data, this.mediaType(kind))
      const media: MediaMessage = {
        url: prepared.url,
        directPath: prepared.directPath,
        mimetype: c.mimetype ?? this.defaultMimetype(kind),
        fileSha256: prepared.enc.fileSha256,
        fileEncSha256: prepared.enc.fileEncSha256,
        fileLength: prepared.enc.fileLength,
        mediaKey: prepared.enc.mediaKey,
        mediaKeyTimestamp: unixTimestampSeconds(),
        caption: c.caption,
        fileName: c.fileName,
        seconds: c.seconds,
        ptt: kind === 'audio' ? (c.ptt ?? false) : undefined,
        gifPlayback: kind === 'video' ? c.gifPlayback : undefined,
        viewOnce: c.viewOnce,
        height: c.height,
        width: c.width,
        jpegThumbnail: c.jpegThumbnail,
        contextInfo: c.contextInfo
      }
      const message: IMessage =
        kind === 'image'
          ? { imageMessage: media }
          : kind === 'video'
            ? { videoMessage: media }
            : kind === 'audio'
              ? { audioMessage: media }
              : kind === 'sticker'
                ? { stickerMessage: media }
                : { documentMessage: media }
      if (c.viewOnce && (kind === 'image' || kind === 'video')) return { viewOnceMessageV2: { message } }
      return message
    }

    if (direct) return content as IMessage
    throw new Error(`unsupported message content: ${Object.keys(c).join(',')}`)
  }

  private inlineContent(c: Record<string, any>): IMessage {
    if (c.text !== undefined) return { extendedTextMessage: { text: c.text } }
    throw new Error('edit requires text')
  }

  private mediaKind(c: Record<string, any>): 'image' | 'video' | 'audio' | 'document' | 'sticker' | undefined {
    for (const kind of ['image', 'video', 'audio', 'document', 'sticker'] as const) {
      if (c[kind] !== undefined) return kind
    }
    return undefined
  }

  private mediaType(kind: string): MediaType {
    return (kind === 'sticker' ? 'image' : kind) as MediaType
  }

  private defaultMimetype(kind: string): string {
    if (kind === 'image') return 'image/jpeg'
    if (kind === 'video') return 'video/mp4'
    if (kind === 'audio') return 'audio/ogg; codecs=opus'
    if (kind === 'sticker') return 'image/webp'
    return 'application/octet-stream'
  }

  private async toMediaBuffer(source: unknown): Promise<Uint8Array> {
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) return source
    if (typeof source === 'string') {
      if (/^https?:\/\//.test(source)) {
        const res = await fetch(source)
        if (!res.ok) throw new Error(`failed to fetch media: ${res.status}`)
        return Buffer.from(await res.arrayBuffer())
      }
      return Buffer.from(await (await import('node:fs/promises')).readFile(source))
    }
    const obj = source as { url?: string; stream?: AsyncIterable<Buffer> }
    if (obj?.url) return this.toMediaBuffer(obj.url)
    if (obj?.stream) {
      const chunks: Buffer[] = []
      for await (const chunk of obj.stream) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks)
    }
    throw new Error('unsupported media source')
  }

  private applyContextInfo(message: IMessage, contextInfo: Record<string, any>): void {
    const normalized = normalizeMessageContent(message) ?? message
    const key = getContentType(normalized)
    if (!key) return
    const content = (normalized as Record<string, any>)[key]
    if (!content || typeof content !== 'object') return
    content.contextInfo = { ...(content.contextInfo ?? {}), ...contextInfo }
  }

  private applyQuoted(message: IMessage, quoted: WAMessage, jid: string): void {
    const normalized = normalizeMessageContent(message) ?? message
    const key = getContentType(normalized)
    if (!key) return
    const content = (normalized as Record<string, any>)[key]
    if (!content || typeof content !== 'object') return
    const quotedContent = normalizeMessageContent(quoted.message) ?? quoted.message
    const participant = quoted.key.fromMe
      ? this.authState.creds.me?.id
      : quoted.key.participant ?? quoted.key.remoteJid
    content.contextInfo = {
      ...(content.contextInfo ?? {}),
      stanzaId: quoted.key.id,
      participant: jidNormalizedUser(participant),
      quotedMessage: quotedContent,
      ...(jid !== quoted.key.remoteJid ? { remoteJid: quoted.key.remoteJid } : {})
    }
  }

  private applyMentions(message: IMessage, mentions: string[]): void {
    const normalized = normalizeMessageContent(message) ?? message
    const key = getContentType(normalized)
    if (!key) return
    const content = (normalized as Record<string, any>)[key]
    if (!content || typeof content !== 'object') return
    content.contextInfo = { ...(content.contextInfo ?? {}), mentionedJid: mentions }
  }

  private async sendBuiltMessage(jid: string, message: IMessage, messageId?: string): Promise<WAMessage> {
    const me = this.authState.creds.me!
    const id = messageId ?? this.generateMessageId(me.id)
    const repo = this.getRepository()
    const isGroupLike = isJidGroup(jid)

    const content: BinaryNode[] = []
    const encrypted = encodeMessage(message)
    const shouldIncludeDeviceIdentity = { value: false }

    const recipients = await this.resolveRecipients(jid, isGroupLike)
    for (const r of recipients) {
      const { nodes } = await this.encryptForRecipients(repo, r, encrypted, shouldIncludeDeviceIdentity)
      content.push(...nodes)
    }
    if (!content.length) throw new Error('No recipients to send to')

    if (shouldIncludeDeviceIdentity.value) {
      const deviceIdentity = this.buildDeviceIdentityNode()
      if (deviceIdentity) content.push(deviceIdentity)
    }

    const stanza: BinaryNode = {
      tag: 'message',
      attrs: { to: jid, id, type: this.messageType(message), ...(isGroupLike ? { addressing_mode: 'lid' } : {}) },
      content
    }
    await this.sendNode(stanza)
    this.sentMessages.set(id, message)
    if (this.sentMessages.size > 512) {
      const oldest = this.sentMessages.keys().next().value
      if (oldest !== undefined) this.sentMessages.delete(oldest)
    }
    return {
      key: { remoteJid: jid, fromMe: true, id, participant: isGroupLike ? me.id : undefined },
      message,
      messageTimestamp: unixTimestampSeconds(),
      messageStubParameters: [],
      status: 1
    }
  }

  /** Encrypt the message for one participant (its own devices, or the group). */
  private async encryptForRecipients(
    repo: SignalRepository,
    recipient: { jid: string; devices: string[]; group?: string; isGroup: boolean },
    encrypted: Buffer,
    pkmsgFlag: { value: boolean }
  ): Promise<{ nodes: BinaryNode[]; included: boolean }> {
    const me = this.authState.creds.me!
    const nodes: BinaryNode[] = []

    if (recipient.isGroup) {
      const group = recipient.group!
      const senderDevice = jidDecode(me.id)?.device ?? 0
      await this.assertSessions(recipient.devices)
      // SKDM once, then the group message.
      if (!(await repo.hasSenderKey(group, jidDecode(me.id)!.user!, senderDevice))) {
        const skdm = await repo.createSenderKeyDistribution(group, jidDecode(me.id)!.user!, senderDevice)
        const skdmMsg = encodeMessage({
          senderKeyDistributionMessage: { groupId: group, axolotlSenderKeyDistributionMessage: skdm }
        })
        for (const device of recipient.devices) {
          const res = await repo.encryptMessage(device, skdmMsg)
          if (res.type === 'pkmsg') pkmsgFlag.value = true
          nodes.push({ tag: 'to', attrs: { jid: device }, content: [{ tag: 'enc', attrs: { v: '2', type: res.type }, content: res.ciphertext }] })
        }
      }
      const groupCipher = await repo.encryptGroupMessage(group, jidDecode(me.id)!.user!, senderDevice, encrypted)
      nodes.push({ tag: 'enc', attrs: { v: '2', type: 'skmsg' }, content: groupCipher })
      return { nodes, included: false }
    }

    const ownDevices = (await this.getOwnDevices()).filter(d => d !== me.id)
    await this.assertSessions([...recipient.devices, ...ownDevices])

    for (const device of recipient.devices) {
      const res = await repo.encryptMessage(device, encrypted)
      if (res.type === 'pkmsg') pkmsgFlag.value = true
      nodes.push({ tag: 'to', attrs: { jid: device }, content: [{ tag: 'enc', attrs: { v: '2', type: res.type }, content: res.ciphertext }] })
    }
    // Also deliver to our own other devices.
    for (const device of ownDevices) {
      const dsMessage = encodeMessage({ deviceSentMessage: { destinationJid: recipient.jid, message: decodeMessage(encrypted) } })
      const res = await repo.encryptMessage(device, dsMessage)
      nodes.push({ tag: 'to', attrs: { jid: device }, content: [{ tag: 'enc', attrs: { v: '2', type: res.type }, content: res.ciphertext }] })
    }
    return { nodes, included: true }
  }

  /** Resolve the concrete device JIDs for a recipient or group. */
  private async resolveRecipients(
    jid: string,
    isGroupLike: boolean
  ): Promise<{ jid: string; devices: string[]; group?: string; isGroup: boolean }[]> {
    if (isGroupLike) {
      const meta = await this.queryGroupMetadata(jid)
      const devices: string[] = []
      for (const p of meta) {
        const devs = await this.getUSyncDevices([p])
        devices.push(...devs)
      }
      return [{ jid, devices, group: jid, isGroup: true }]
    }
    const devices = await this.getUSyncDevices([jidNormalizedUser(jid)])
    return [{ jid, devices, isGroup: false }]
  }

  private async getOwnDevices(): Promise<string[]> {
    const me = this.authState.creds.me
    if (!me) return []
    try {
      return await this.getUSyncDevices([jidNormalizedUser(me.id)], true)
    } catch {
      return [me.id]
    }
  }

  /** Query device lists via USync and cache nothing (memory-frugal). */
  private async getUSyncDevices(jids: string[], forceQuery = false): Promise<string[]> {
    const me = this.authState.creds.me!
    const query = buildUSyncDeviceQuery(jids, this.generateMessageTag())
    const result = await this.query(query)
    const parsed = parseUSyncDeviceResult(result)
    const repo = this.getRepository()
    const mappings = parsed
      .filter(u => u.lid)
      .map(u => ({ lid: u.lid!, pn: jidNormalizedUser(u.id) }))
    if (mappings.length) await repo.lidMapping.storeLIDPNMappings(mappings)
    const full = extractDeviceJids(parsed, me.id, me.lid ?? '', false)
    if (forceQuery) return full.map(deviceJid)
    return full.map(deviceJid)
  }

  /**
   * Fetch pre-key bundles for devices with no session yet and inject them, so
   * the subsequent encrypt produces a `pkmsg`. Sessions are only keyed on the
   * wire id (LID when a mapping exists), matching the server's addressing.
   */
  private async assertSessions(devices: string[]): Promise<void> {
    const repo = this.getRepository()
    const missing: string[] = []
    for (const device of devices) {
      if (!(await repo.hasSession(device))) missing.push(device)
    }
    if (!missing.length) return

    const wireJids = await this.toWireJids(missing)
    if (!wireJids.length) return

    const result = await this.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'encrypt' },
      content: [{ tag: 'key', attrs: {}, content: wireJids.map(jid => ({ tag: 'user', attrs: { jid } })) }]
    })

    for (const user of getBinaryNodeChildren(getBinaryNodeChild(result, 'list'), 'user')) {
      const jid = user.attrs.jid
      if (!jid) continue
      const identity = getBinaryNodeChildBuffer(user, 'identity')
      const signedPreKey = this.extractPreKey(user, 'skey')
      const preKey = this.extractPreKey(user, 'key')
      if (!identity || !signedPreKey) continue
      await repo.injectE2ESession(jid, {
        registrationId: getBinaryNodeChildUInt(user, 'registration', 4) ?? 0,
        identityKey: generateSignalPubKey(identity),
        signedPreKey: {
          ...signedPreKey,
          publicKey: generateSignalPubKey(signedPreKey.publicKey),
          signature: signedPreKey.signature
        },
        preKey: preKey && { keyId: preKey.keyId, publicKey: generateSignalPubKey(preKey.publicKey) }
      })
    }
  }

  private extractPreKey(
    node: BinaryNode,
    tag: string
  ): { keyId: number; publicKey: Uint8Array; signature: Uint8Array } | undefined {
    const key = getBinaryNodeChild(node, tag)
    if (!key) return undefined
    const publicKey = getBinaryNodeChildBuffer(key, 'value')
    if (!publicKey) return undefined
    return {
      keyId: getBinaryNodeChildUInt(key, 'id', 3) ?? 0,
      publicKey,
      signature: getBinaryNodeChildBuffer(key, 'signature') ?? new Uint8Array(0)
    }
  }

  /** Map device JIDs to the LID form the server uses for the session fetch. */
  private async toWireJids(devices: string[]): Promise<string[]> {
    const repo = this.getRepository()
    const out: string[] = []
    for (const device of devices) {
      if (isLidUser(device)) {
        out.push(device)
      } else if (isPnUser(device)) {
        const lid = await repo.lidMapping.getLIDForPN(jidNormalizedUser(device))
        if (lid) {
          const decoded = jidDecode(lid)!
          const dev = jidDecode(device)?.device ?? 0
          out.push(`${decoded.user}:${dev}@lid`)
        } else {
          out.push(device)
        }
      } else {
        out.push(device)
      }
    }
    return out
  }

  private async queryGroupMetadata(jid: string): Promise<string[]> {
    const result = await this.query({
      tag: 'iq',
      attrs: { to: jid, xmlns: 'w:g2', type: 'get' },
      content: [{ tag: 'query', attrs: { request: 'interactive' } }]
    })
    const group = getBinaryNodeChild(result, 'group')
    const participants = getBinaryNodeChild(group, 'participants')
    return getBinaryNodeChildren(participants, 'participant')
      .map(p => p.attrs.jid)
      .filter((j): j is string => typeof j === 'string')
  }

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  /** Encrypt + upload a media buffer, returning the fields a media message needs. */
  async prepareMedia(
    data: Uint8Array,
    type: MediaType
  ): Promise<{ url: string; directPath: string; enc: ReturnType<typeof encryptMedia> }> {
    const enc = encryptMedia(data, type)
    const conn = await this.refreshMediaConn(false)
    const { url, directPath } = await uploadMedia(enc.encrypted, enc.fileEncSha256, type, force => this.refreshMediaConn(force))
    return { url, directPath, enc }
  }

  /**
   * Baileys-compatible media upload entry point. Accepts the several shapes a
   * host may hand back — a Buffer, a `{ type: 'Buffer', data }` BufferJSON
   * object, a `{ stream }` async iterable, or a file path — and pushes the
   * (already encrypted) bytes to the media host.
   */
  waUploadToServer = async (
    encrypted: unknown,
    opts: { mediaType: MediaType; fileEncSha256B64: string }
  ): Promise<{ url: string; mediaUrl: string; directPath: string }> => {
    const buf = await toUploadBuffer(encrypted)
    const fileEncSha256 = Buffer.from(opts.fileEncSha256B64, 'base64')
    const result = await uploadMedia(buf, fileEncSha256, opts.mediaType, force => this.refreshMediaConn(force))
    return { url: result.url, mediaUrl: result.url, directPath: result.directPath }
  }

  async sendImage(
    jid: string,
    image: Uint8Array,
    opts: { caption?: string; mimetype?: string; fileName?: string } = {}
  ): Promise<WAMessage> {
    const { url, directPath, enc } = await this.prepareMedia(image, 'image')
    const message: IMessage = {
      imageMessage: {
        url,
        directPath,
        mimetype: opts.mimetype ?? 'image/jpeg',
        fileSha256: enc.fileSha256,
        fileEncSha256: enc.fileEncSha256,
        fileLength: enc.fileLength,
        mediaKey: enc.mediaKey,
        mediaKeyTimestamp: Math.floor(Date.now() / 1000),
        caption: opts.caption
      }
    }
    return this.sendMessage(jid, message)
  }

  async sendMedia(
    jid: string,
    data: Uint8Array,
    type: MediaType,
    opts: { caption?: string; mimetype?: string; fileName?: string; seconds?: number; ptt?: boolean; height?: number; width?: number } = {}
  ): Promise<WAMessage> {
    const { url, directPath, enc } = await this.prepareMedia(data, type)
    const base = {
      url,
      directPath,
      mimetype: opts.mimetype ?? 'application/octet-stream',
      fileSha256: enc.fileSha256,
      fileEncSha256: enc.fileEncSha256,
      fileLength: enc.fileLength,
      mediaKey: enc.mediaKey,
      mediaKeyTimestamp: Math.floor(Date.now() / 1000),
      caption: opts.caption,
      fileName: opts.fileName,
      seconds: opts.seconds,
      ptt: opts.ptt,
      height: opts.height,
      width: opts.width
    }
    const message: IMessage =
      type === 'image'
        ? { imageMessage: base }
        : type === 'video' || type === 'gif'
          ? { videoMessage: { ...base, gifPlayback: type === 'gif' } }
          : type === 'audio' || type === 'ptt'
            ? { audioMessage: base }
            : { documentMessage: base }
    return this.sendMessage(jid, message)
  }

  private refreshMediaConn(forceGet: boolean): Promise<MediaConnInfo> {
    const cached = this.mediaConn
    if (!cached || forceGet || Date.now() - (this._mediaFetchDate ?? 0) > 3_600_000) {
      this._mediaFetchDate = Date.now()
      this.mediaConn = (async () => {
        const result = await this.query({
          tag: 'iq',
          attrs: { type: 'set', xmlns: 'w:m', to: S_WHATSAPP_NET },
          content: [{ tag: 'media_conn', attrs: {} }]
        })
        const node = getBinaryNodeChild(result, 'media_conn')!
        return {
          hosts: getBinaryNodeChildren(node, 'host').map(h => ({
            hostname: h.attrs.hostname!,
            maxContentLengthBytes: +h.attrs.maxContentLengthBytes!
          })),
          auth: node.attrs.auth!,
          ttl: +node.attrs.ttl!,
          fetchDate: new Date()
        }
      })()
    }
    return this.mediaConn!
  }

  private _mediaFetchDate = 0

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  private async handleIncomingMessage(stanza: BinaryNode): Promise<void> {
    try {
      const attrs = stanza.attrs
      const from = attrs.from!
      const participant = attrs.participant
      const recipient = attrs.recipient
      const repo = this.getRepository()

      // A message routed through a companion arrives with `recipient` set to the
      // chat and `from` set to our own device; group self-echoes carry our own
      // participant. Mirrors Baileys `decodeMessageNode` so hosts that filter on
      // `key.fromMe` (e.g. private-mode bots) see our own messages.
      const me = this.authState.creds.me
      const meLid = me?.lid
      const isMe = (jid?: string) => !!jid && (areJidsSameUser(jid, me?.id) || areJidsSameUser(jid, meLid))
      const remoteJid = recipient && !isJidMetaAI(recipient) ? recipient : from
      const fromMe = isJidGroup(from) || isJidBroadcast(from) ? isMe(participant) : isMe(from)

      const authorJid = participant ?? from
      const decryptResult = await this.decryptMessageNode(stanza, repo, authorJid)
      if (!decryptResult) return

      const message = decodeMessage(decryptResult.plaintext)
      const messageTimestamp = attrs.t ? +attrs.t : Math.floor(Date.now() / 1000)
      // Baileys always exposes the alternate addressing form: `remoteJidAlt` on
      // 1:1 chats (the sender's LID/PN counterpart) and `participantAlt` on
      // groups. Hosts resolve the phone number through these, so dropping them
      // leaves a LID-addressed message with no resolvable identity.
      const addressing = extractAddressingContext(stanza)
      const isGroupChat = isJidGroup(remoteJid)
      const incoming: IncomingMessage = {
        key: {
          remoteJid,
          remoteJidAlt: !isGroupChat ? addressing.senderAlt : undefined,
          remoteJidUsername: !isGroupChat ? attrs.peer_recipient_username || attrs.recipient_username : undefined,
          fromMe,
          id: attrs.id!,
          participant,
          participantAlt: isGroupChat ? addressing.senderAlt : undefined,
          participantUsername: participant ? attrs.participant_username : undefined
        },
        message,
        messageTimestamp,
        ...(attrs.notify ? { pushName: attrs.notify } : {})
      }
      const chat = this.chats.get(remoteJid) ?? { id: remoteJid }
      chat.conversationTimestamp = messageTimestamp
      this.chats.set(remoteJid, chat)
      this.sentMessages.set(attrs.id!, message)
      if (this.sentMessages.size > 512) {
        const oldest = this.sentMessages.keys().next().value
        if (oldest !== undefined) this.sentMessages.delete(oldest)
      }
      this.config.onMessage?.(incoming)
      this.ev.emit('messages.upsert', { messages: [incoming], type: 'notify' })
      void this.sendMessageAck(stanza)
    } catch (err) {
      this.config.logger.warn({ err }, 'failed to handle incoming message')
      // WA Web retry-receipts a message it cannot decrypt *and* NACKs the
      // stanza. Sending only the retry receipt leaves the server waiting on an
      // ack, which can stall the delivery queue.
      void this.retryRequest(stanza).catch(() => {})
      void this.sendMessageAck(stanza, 500)
    }
  }

  private async retryRequest(stanza: BinaryNode): Promise<void> {
    const id = stanza.attrs.id
    if (!id || !stanza.attrs.from) return
    const attempts = (this.messageRetryCache.get(id) ?? 0) + 1
    if (attempts > 3) {
      this.messageRetryCache.delete(id)
      return
    }
    this.messageRetryCache.set(id, attempts)
    if (this.messageRetryCache.size > 1024) {
      const oldest = this.messageRetryCache.keys().next().value
      if (oldest !== undefined) this.messageRetryCache.delete(oldest)
    }
    const enc = getBinaryNodeChild(stanza, 'enc')
    const participant = stanza.attrs.participant ?? stanza.attrs.from
    await this.sendNode({
      tag: 'receipt',
      attrs: {
        id,
        to: stanza.attrs.from,
        type: 'retry',
        ...(participant ? { participant } : {})
      },
      content: enc ? [enc] : undefined
    }).catch(() => {})
  }

  private async decryptMessageNode(
    stanza: BinaryNode,
    repo: SignalRepository,
    authorJid: string
  ): Promise<{ plaintext: Buffer } | undefined> {
    const enc = getBinaryNodeChild(stanza, 'enc')
    if (!enc) return undefined
    const type = enc.attrs.type as 'msg' | 'pkmsg' | 'skmsg'
    const ciphertext = Buffer.isBuffer(enc.content) ? enc.content : Buffer.from(enc.content as Uint8Array)
    const from = stanza.attrs.from!

    let plaintext: Buffer
    if (type === 'skmsg') {
      plaintext = await repo.decryptGroupMessage(from, authorJid, ciphertext)
    } else {
      plaintext = await repo.decryptMessage(authorJid, type, ciphertext)
    }

    const message = decodeMessage(plaintext)
    // Unwrap device-sent and process group sender-key distributions.
    if (message.senderKeyDistributionMessage?.axolotlSenderKeyDistributionMessage) {
      await repo.processSenderKeyDistribution(from, authorJid, message.senderKeyDistributionMessage.axolotlSenderKeyDistributionMessage)
    }
    if (message.deviceSentMessage) {
      return { plaintext: encodeMessage(message.deviceSentMessage.message) }
    }
    return { plaintext }
  }

  /** Ack a received notification/info stanza; no-op when it carries no id/from. */
  private async ackStanza(node: BinaryNode): Promise<void> {
    if (!node.attrs.id || !node.attrs.from) return
    await this.sendNode(buildAckStanza(node, undefined, this.authState.creds.me?.id)).catch(() => {})
  }

  private async sendMessageAck(stanza: BinaryNode, errorCode?: number): Promise<void> {
    if (!stanza.attrs.id || !stanza.attrs.from) return
    const meId = this.authState.creds.me?.id
    await this.sendNode(buildAckStanza(stanza, errorCode, meId)).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private generateMessageId(meId: string): string {
    const user = jidDecode(meId)?.user ?? ''
    // 16 hex chars, same shape as WA Web message ids.
    const rand = randomBytes(8).toString('hex').toUpperCase()
    void user
    return rand
  }

  private messageType(_message: IMessage): string {
    return 'text'
  }

  private buildDeviceIdentityNode(): BinaryNode | null {
    // The account blob is populated during pairing; without it we simply skip
    // the device identity, which the server accepts for companion sessions.
    const account = this.authState.creds.account as { deviceIdentity?: Uint8Array } | undefined
    if (!account?.deviceIdentity) return null
    return { tag: 'device-identity', attrs: {}, content: account.deviceIdentity }
  }

  /** Ask the server for a pairing code for a phone number (linked-device flow). */
  async requestPairingCode(phoneNumber: string, customPairingCode?: string): Promise<string> {
    const pairingCode = customPairingCode ?? bytesToCrockford(randomBytes(5))
    if (customPairingCode && customPairingCode.length !== 8) {
      throw new Error('Custom pairing code must be exactly 8 chars')
    }

    // The request is a transport node, so it can only go out once the Noise
    // handshake has installed the encryption keys. Hosts commonly call this
    // right after `makeWASocket`, before the websocket is even open.
    await this.awaitTransport()

    this.authState.creds.pairingCode = pairingCode
    this.authState.creds.me = { id: `${phoneNumber}@s.whatsapp.net`, name: '~' }
    this.ev.emit('creds.update', this.authState.creds)

    const wrapped = await this.generatePairingKey(pairingCode)
    await this.sendNode({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'set', id: this.generateMessageTag(), xmlns: 'md' },
      content: [
        {
          tag: 'link_code_companion_reg',
          attrs: {
            jid: this.authState.creds.me.id,
            stage: 'companion_hello',
            should_show_push_notification: 'true'
          },
          content: [
            { tag: 'link_code_pairing_wrapped_companion_ephemeral_pub', attrs: {}, content: wrapped },
            { tag: 'companion_server_auth_key_pub', attrs: {}, content: this.authState.creds.noiseKey.public },
            { tag: 'companion_platform_id', attrs: {}, content: getCompanionPlatformId(this.config.browser) },
            { tag: 'companion_platform_display', attrs: {}, content: `${this.config.browser[1]} (${this.config.browser[0]})` },
            { tag: 'link_code_pairing_nonce', attrs: {}, content: '0' }
          ]
        }
      ]
    })
    return pairingCode
  }

  /**
   * Wait until the Noise transport is usable. Rejects if the connection drops
   * (or was never started) before the handshake completes, so callers fail
   * fast instead of hanging on a socket that will never open.
   */
  private async awaitTransport(): Promise<void> {
    if (!this.transportReady) throw new Error('Connection Closed')
    await this.transportReady.promise
  }

  private async generatePairingKey(pairingCode: string): Promise<Buffer> {
    const salt = randomBytes(32)
    const iv = randomBytes(16)
    const key = await derivePairingCodeKey(pairingCode, salt)
    const ciphered = aesEncryptCTR(this.authState.creds.pairingEphemeralKeyPair.public, key, iv)
    return Buffer.concat([salt, iv, ciphered])
  }

  private async end(error?: Error, statusCode?: number): Promise<void> {
    if (this.closed) return
    this.closed = true

    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    if (this.qrTimer) clearTimeout(this.qrTimer)
    this.keepAliveTimer = null
    this.qrTimer = null

    const ws = this._ws
    if (ws) {
      ws.removeAllListeners()
      // Closing a still-connecting socket makes ws emit an async 'error'
      // ("closed before the connection was established"); the no-op listener
      // keeps that from crashing the host process.
      ws.on('error', () => {})
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close()
        } catch {}
      }
    }
    this._ws = null
    this.noise = null
    let err = error ?? new Error('Connection Closed')
    if (statusCode !== undefined && statusCode !== 1000 && statusCode !== 1005) {
      ;(err as Error & { output: { statusCode: number } }).output = { statusCode }
    }
    // Reject in-flight queries instead of merely dropping them: a dropped
    // resolver both hangs the awaiter and keeps its closure alive until GC.
    for (const [, pending] of this.pendingResolvers) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pendingResolvers.clear()
    // Fail any waiter on the Noise transport (e.g. an in-flight pairing-code
    // request) instead of leaving it pending on a connection that is gone.
    this.transportReady?.reject(err)
    this.transportReady = null
    if (this.handshakeRejecter) {
      const reject = this.handshakeRejecter
      this.handshakeResolver = null
      this.handshakeRejecter = null
      reject(err)
    }

    this.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: err, date: new Date() } })
  }

  get signalRepository(): SignalRepository {
    return this.getRepository()
  }

  get ws(): WebSocket | null {
    return this._ws
  }

  async groupMetadata(jid: string): Promise<GroupMetadata> {
    const cached = this.groupMetaCache.get(jid)
    if (cached) return cached
    if (this.config.cachedGroupMetadata) {
      const hostCached = await this.config.cachedGroupMetadata(jid).catch(() => undefined)
      if (hostCached) {
        this.groupMetaCache.set(jid, hostCached)
        return hostCached
      }
    }
    const result = await this.query({
      tag: 'iq',
      attrs: { type: 'get', xmlns: 'w:g2', to: jid },
      content: [{ tag: 'query', attrs: { request: 'interactive' } }]
    })
    const meta = this.buildGroupMetadata(getBinaryNodeChild(result, 'group') ?? { tag: 'group', attrs: {} })
    this.groupMetaCache.set(jid, meta)
    if (this.groupMetaCache.size > 256) {
      const oldest = this.groupMetaCache.keys().next().value
      if (oldest !== undefined) this.groupMetaCache.delete(oldest)
    }
    return meta
  }

  async groupFetchAllParticipating(): Promise<Record<string, GroupMetadata>> {
    const result = await this.query({
      tag: 'iq',
      attrs: { to: '@g.us', xmlns: 'w:g2', type: 'get' },
      content: [
        {
          tag: 'participating',
          attrs: {},
          content: [
            { tag: 'participants', attrs: {} },
            { tag: 'description', attrs: {} }
          ]
        }
      ]
    })
    const data: Record<string, GroupMetadata> = {}
    const groupsNode = getBinaryNodeChild(result, 'groups')
    if (groupsNode) {
      for (const groupNode of getBinaryNodeChildren(groupsNode, 'group')) {
        const meta = this.buildGroupMetadata(groupNode)
        data[meta.id] = meta
        this.groupMetaCache.set(meta.id, meta)
      }
    }
    this.ev.emit('groups.update', Object.values(data))
    return data
  }

  async groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: GroupParticipantAction
  ): Promise<{ status: string; jid: string }[]> {
    const result = await this.query({
      tag: 'iq',
      attrs: { type: 'set', xmlns: 'w:g2', to: jid },
      content: [
        {
          tag: action,
          attrs: {},
          content: participants.map(p => ({ tag: 'participant', attrs: { jid: p } }))
        }
      ]
    })
    this.groupMetaCache.delete(jid)
    const node = getBinaryNodeChild(result, action)
    return getBinaryNodeChildren(node, 'participant').map(p => ({
      status: p.attrs.error ?? '200',
      jid: p.attrs.jid ?? ''
    }))
  }

  async groupInviteCode(jid: string): Promise<string | undefined> {
    const result = await this.query({
      tag: 'iq',
      attrs: { type: 'get', xmlns: 'w:g2', to: jid },
      content: [{ tag: 'invite', attrs: {} }]
    })
    return getBinaryNodeChild(result, 'invite')?.attrs.code
  }

  async profilePictureUrl(jid: string, type: 'preview' | 'image' = 'preview'): Promise<string | undefined> {
    const result = await this.query({
      tag: 'iq',
      attrs: { target: jidNormalizedUser(jid), to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:profile:picture' },
      content: [{ tag: 'picture', attrs: { type, query: 'url' } }]
    })
    return getBinaryNodeChild(result, 'picture')?.attrs.url
  }

  async sendPresenceUpdate(type: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused', to?: string): Promise<void> {
    const me = this.authState.creds.me
    if (!me) return
    // `available`/`unavailable` are global presence and carry our push name;
    // `composing`/`recording`/`paused` are per-chat chatstate stanzas.
    if (type === 'available' || type === 'unavailable') {
      this.ev.emit('connection.update', { isOnline: type === 'available' })
      // A QR-linked companion has no push name until app-state sync (which
      // lightwa does not implement yet), but the presence stanza still flips the
      // linked device to online on the phone. Baileys bails out when `me.name`
      // is missing, which is why such sessions show only "last active"; send the
      // stanza regardless and include the name only when we actually have one.
      await this.sendNode({
        tag: 'presence',
        attrs: { ...(me.name ? { name: me.name.replace(/@/g, '') } : {}), type },
        content: undefined
      })
      return
    }
    if (!to) return
    const server = jidDecode(to)?.server
    await this.sendNode({
      tag: 'chatstate',
      attrs: { from: server === 'lid' && me.lid ? me.lid : me.id, to },
      content: [{ tag: type === 'recording' ? 'composing' : type, attrs: type === 'recording' ? { media: 'audio' } : {} }]
    })
  }

  async sendReceipt(jid: string, participant: string | undefined, ids: string[], type: 'read' | 'read-self' | 'played' | 'delivered'): Promise<void> {
    await this.sendNode({
      tag: 'receipt',
      attrs: { to: jid, ...(participant ? { participant } : {}), type, id: ids[0]! },
      content: ids.slice(1).map(id => ({ tag: 'list', attrs: { id } }))
    })
  }

  /** Bulk send receipts, grouped by chat + participant, skipping our own messages. */
  async sendReceipts(keys: WAMessageKey[], type: 'read' | 'read-self' | 'played' | 'delivered'): Promise<void> {
    const groups = new Map<string, { jid: string; participant?: string; messageIds: string[] }>()
    for (const { remoteJid, id, participant, fromMe } of keys) {
      if (fromMe || !remoteJid) continue
      const uqKey = `${remoteJid}:${participant || ''}`
      let g = groups.get(uqKey)
      if (!g) groups.set(uqKey, (g = { jid: remoteJid, participant, messageIds: [] }))
      g.messageIds.push(id)
    }
    for (const g of groups.values()) await this.sendReceipt(g.jid, g.participant, g.messageIds, type)
  }

  /** Bulk read messages, honouring the account's read-receipt privacy setting. */
  async readMessages(keys: WAMessageKey[]): Promise<void> {
    const privacy = await this.fetchPrivacySettings()
    const readType = privacy.readreceipts === 'all' ? 'read' : 'read-self'
    await this.sendReceipts(keys, readType)
  }

  async presenceSubscribe(toJid: string): Promise<void> {
    const normalized = jidNormalizedUser(toJid)
    const isUserJid = isPnUser(normalized) || isLidUser(normalized)
    await this.sendNode({
      tag: 'presence',
      attrs: { to: toJid, id: this.generateMessageTag(), type: isUserJid ? 'subscribe' : 'available' }
    })
  }

  async fetchPrivacySettings(force = false): Promise<Record<string, string>> {
    if (!this.privacySettings || force) {
      const result = await this.query({
        tag: 'iq',
        attrs: { xmlns: 'privacy', to: S_WHATSAPP_NET, type: 'get' },
        content: [{ tag: 'privacy', attrs: {} }]
      })
      const privacy = getBinaryNodeChild(result, 'privacy')
      const dict: Record<string, string> = {}
      for (const category of getBinaryNodeChildren(privacy, 'category')) {
        const name = category.attrs.name
        if (typeof name === 'string') dict[name] = category.attrs.value || category.attrs.config_value || ''
      }
      this.privacySettings = dict
    }
    return this.privacySettings
  }

  async fetchStatus(...jids: string[]): Promise<Record<string, unknown>[]> {
    return this.executeUSyncQuery(
      [{ name: 'status', query: { tag: 'status', attrs: {} }, user: () => null, parse: node => ({ status: node.content?.toString() ?? null, setAt: new Date(+(node.attrs.t || 0) * 1000) }) }],
      jids.map(id => ({ id }))
    )
  }

  async onWhatsApp(...phoneNumbers: string[]): Promise<{ jid: string; exists: boolean }[]> {
    const users: USyncUserInput[] = []
    for (const jid of phoneNumbers) {
      if (isLidUser(jid)) continue
      users.push({ phone: `+${jid.replace('+', '').split('@')[0]?.split(':')[0]}` })
    }
    if (users.length === 0) return []
    const list = await this.executeUSyncQuery(
      [{ name: 'contact', query: { tag: 'contact', attrs: {} }, user: u => ({ tag: 'contact', attrs: {}, content: u.phone }), parse: node => node.attrs.type === 'in' }],
      users
    )
    return list.map(r => ({ jid: r.id as string, exists: !!r.contact }))
  }

  async updateProfileStatus(status: string): Promise<void> {
    await this.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'status' },
      content: [{ tag: 'status', attrs: {}, content: Buffer.from(status, 'utf-8') }]
    })
  }

  async updateProfileName(name: string): Promise<void> {
    if (!this.authState.creds.me) throw new Error('Not logged in')
    await this.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:pushname' },
      content: [{ tag: 'pushname', attrs: {}, content: Buffer.from(name, 'utf-8') }]
    })
    this.authState.creds.me.name = name
    this.ev.emit('creds.update', { me: this.authState.creds.me })
  }

  async getBusinessProfile(jid: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, xmlns: 'w:biz', type: 'get' },
      content: [
        { tag: 'business_profile', attrs: { v: '244' }, content: [{ tag: 'profile', attrs: { jid } }] }
      ]
    })
    const profiles = getBinaryNodeChild(getBinaryNodeChild(result, 'business_profile'), 'profile')
    if (!profiles) return
    const businessHours = getBinaryNodeChild(profiles, 'business_hours')
    const website = getBinaryNodeChild(profiles, 'website')?.content?.toString()
    return {
      wid: profiles.attrs.jid,
      address: getBinaryNodeChild(profiles, 'address')?.content?.toString(),
      description: getBinaryNodeChild(profiles, 'description')?.content?.toString() || '',
      website: website ? [website] : [],
      email: getBinaryNodeChild(profiles, 'email')?.content?.toString(),
      category: getBinaryNodeChild(getBinaryNodeChild(profiles, 'categories'), 'category')?.content?.toString(),
      business_hours: {
        timezone: businessHours?.attrs.timezone,
        business_config: getBinaryNodeChildren(businessHours, 'business_hours_config').map(n => n.attrs)
      }
    }
  }

  /** Log out: tell the server to drop this companion, then close locally. */
  async logout(msg?: string): Promise<void> {
    const me = this.authState.creds.me
    if (me) {
      await this.sendNode({
        tag: 'iq',
        attrs: { to: S_WHATSAPP_NET, type: 'set', id: this.generateMessageTag(), xmlns: 'md' },
        content: [{ tag: 'remove-companion-device', attrs: { jid: me.id, reason: 'user_initiated' } }]
      })
    }
    await this.end(new Error(msg || 'Intentional Logout'), DisconnectReason.loggedOut)
  }

  async relayMessage(jid: string, message: IMessage, options: SendMessageOptions = {}): Promise<string> {
    const built = await this.sendBuiltMessage(jid, message, options.messageId)
    return built.key.id
  }

  /** Send a reaction (or clear one with an empty text) to a message. */
  async sendReact(jid: string, emoji: string, key: WAMessage['key']): Promise<WAMessage> {
    return this.sendMessage(jid, { react: { text: emoji, key } })
  }

  /**
   * Send an album: one `albumMessage` envelope followed by each media child,
   * associated to the envelope via `messageContextInfo.messageAssociation`.
   * V3 implements this on top of the socket, but lightwa provides it natively
   * so the socket is a strict superset of what consumers expect.
   */
  async sendAlbum(
    jid: string,
    medias: { type: 'image' | 'video'; data: unknown }[],
    options: { caption?: string; quoted?: WAMessage } = {}
  ): Promise<WAMessage> {
    if (!Array.isArray(medias) || medias.length < 1) throw new Error('sendAlbum requires at least 1 media')

    const contextInfo = options.quoted
      ? {
          remoteJid: options.quoted.key.remoteJid,
          fromMe: options.quoted.key.fromMe,
          stanzaId: options.quoted.key.id,
          participant: options.quoted.key.participant ?? options.quoted.key.remoteJid,
          quotedMessage: options.quoted.message
        }
      : undefined

    const album = await this.sendMessage(jid, {
      messageContextInfo: {},
      albumMessage: {
        expectedImageCount: medias.filter(m => m.type === 'image').length,
        expectedVideoCount: medias.filter(m => m.type === 'video').length,
        ...(contextInfo ? { contextInfo } : {})
      }
    })

    for (let i = 0; i < medias.length; i++) {
      const { type, data } = medias[i]!
      await this.sendMessage(
        jid,
        { [type]: data, ...(i === 0 && options.caption ? { caption: options.caption } : {}) },
        {
          contextInfo: {
            messageAssociation: { associationType: 1, parentMessageKey: album.key }
          }
        }
      )
      if (i < medias.length - 1) await new Promise(r => setTimeout(r, 500))
    }

    return album
  }

  async downloadMediaMessage(message: WAMessage | IMessage, type?: string): Promise<Buffer> {
    const content = (message as WAMessage).message ?? (message as IMessage)
    const normalized = normalizeMessageContent(content) ?? content ?? {}
    const kind = getContentType(normalized)
    if (!kind || !kind.endsWith('Message')) throw new Error('no downloadable media in message')
    const media = (normalized as Record<string, any>)[kind] as MediaMessage
    const host = 'mmg.whatsapp.net'
    const url = media.directPath ? `https://${host}${media.directPath}` : media.url
    const res = await fetch(url)
    if (!res.ok) throw new Error(`media download failed: ${res.status}`)
    const encrypted = Buffer.from(await res.arrayBuffer())
    const mediaType = kind.replace(/Message$/, '') as MediaType
    void type
    return decryptMedia(encrypted, media.mediaKey, mediaType)
  }

  async close(): Promise<void> {
    await this.end(new Error('Intentional close'))
    this.ev.removeAllListeners()
  }
}

export { initAuthState, initAuthCreds }
export type { AuthenticationState }
