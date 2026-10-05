import WebSocket from 'ws'
import { randomBytes } from 'node:crypto'
import { Curve, aesEncryptCTR, derivePairingCodeKey } from '../crypto/index.js'
import type { KeyPair } from '../crypto/index.js'
import { encodeBinaryNode } from '../wabinary/encode.js'
import { decodeBinaryNode } from '../wabinary/decode.js'
import { getBinaryNodeChild, getBinaryNodeChildren } from '../wabinary/generic-utils.js'
import { S_WHATSAPP_NET } from '../wabinary/jid.js'
import type { BinaryNode } from '../wabinary/types.js'
import { encodeHandshakeMessage, decodeHandshakeMessage } from '../proto/handshake.js'
import { encodeClientPayload } from '../proto/client-payload.js'
import { NoiseHandler, NOISE_WA_HEADER } from './noise-handler.js'
import { bytesToCrockford } from '../utils/generics.js'
import { initAuthState, initAuthCreds, type AuthenticationState } from '../utils/auth-utils.js'
import { buildCompanionFinish, configureSuccessfulPairing, generateLoginNode, generateRegistrationNode, type ConnectionConfig } from '../utils/validate-connection.js'
import { buildPairingQRData, getCompanionPlatformId } from '../utils/companion-utils.js'
import { Browsers, type BrowserDescription } from '../utils/browser-utils.js'
import { Emitter } from '../utils/emitter.js'
import { SignalRepository } from '../signal/repository.js'
import { encodeMessage, decodeMessage, type IMessage } from '../proto/message.js'
import {
  buildUSyncDeviceQuery,
  parseUSyncDeviceResult,
  extractDeviceJids,
  deviceJid,
  type USyncDeviceResult
} from '../usync/index.js'
import {
  encryptMedia,
  decryptMedia,
  uploadMedia,
  type MediaConnInfo,
  type MediaType
} from '../media/index.js'
import { encodeBigEndian } from '../utils/generics.js'
import { jidDecode, jidNormalizedUser, isJidGroup } from '../wabinary/jid.js'

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
  unavailableService = 503
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
  /** How long each QR stays live (ms). */
  qrTimeout?: number
  auth?: AuthenticationState
  logger?: Logger
  /** Test hook: override the certificate authority key/serial. */
  noiseCertPublicKey?: Uint8Array
  noiseCertSerial?: number
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
  lastDisconnect?: { error?: Error; date: Date }
}

type UserEvents = {
  'connection.update': (update: ConnectionUpdate) => void
  'creds.update': (creds: unknown) => void
  'messages.upsert': (payload: { messages: IncomingMessage[] }) => void
}

export interface IncomingMessage {
  key: { remoteJid: string; fromMe: boolean; id: string; participant?: string }
  message: IMessage
  messageTimestamp: number
}

const DEFAULT_VERSION: [number, number, number] = [2, 3000, 1043857760]
const DEFAULT_URL = 'wss://web.whatsapp.com/ws/chat'
const DEFAULT_ORIGIN = 'https://web.whatsapp.com'
const MAX_QR_REFS = 5

export class WAClient {
  readonly ev = new Emitter<UserEvents>()
  readonly authState: AuthenticationState

  private ws: WebSocket | null = null
  private noise: NoiseHandler | null = null
  private readonly config: Required<Pick<SocketConfig, 'waWebSocketUrl' | 'origin' | 'version' | 'browser' | 'connectTimeoutMs' | 'keepAliveIntervalMs' | 'qrTimeout'>> & {
    countryCode: string
    syncFullHistory: boolean
    pushName?: string
    logger: Logger
    noiseCertPublicKey?: Uint8Array
    noiseCertSerial?: number
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

  constructor(config: SocketConfig = {}) {
    this.authState = config.auth ?? initAuthState()
    this.config = {
      waWebSocketUrl: config.waWebSocketUrl ?? DEFAULT_URL,
      origin: config.origin ?? DEFAULT_ORIGIN,
      version: config.version ?? DEFAULT_VERSION,
      browser: config.browser ?? Browsers.macOS('Chrome'),
      connectTimeoutMs: config.connectTimeoutMs ?? 20_000,
      keepAliveIntervalMs: config.keepAliveIntervalMs ?? 30_000,
      qrTimeout: config.qrTimeout ?? 60_000,
      countryCode: config.countryCode ?? 'US',
      syncFullHistory: config.syncFullHistory ?? true,
      pushName: config.pushName,
      logger: config.logger ?? silentLogger,
      noiseCertPublicKey: config.noiseCertPublicKey,
      noiseCertSerial: config.noiseCertSerial
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
    const ws = this.ws
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

  /** Connect and open the websocket. Handshake happens on the 'open' event. */
  connect(): void {
    if (this.ws) return
    this.closed = false

    this.ephemeralKeyPair = Curve.generateKeyPair()
    this.noise = new NoiseHandler({
      keyPair: this.ephemeralKeyPair,
      logger: this.config.logger,
      certPublicKey: this.config.noiseCertPublicKey,
      certSerial: this.config.noiseCertSerial
    })

    this.ev.emit('connection.update', { connection: 'connecting', qr: undefined })

    const ws = new WebSocket(this.config.waWebSocketUrl, {
      origin: this.config.origin,
      handshakeTimeout: this.config.connectTimeoutMs,
      timeout: this.config.connectTimeoutMs
    })
    this.ws = ws
    ws.setMaxListeners(0)

    ws.on('open', () => {
      void this.validateConnection().catch(err => void this.end(err as Error))
    })
    ws.on('message', (data: WebSocket.RawData) => {
      this.lastDateRecv = Date.now()
      void this.onMessageReceived(data)
    })
    ws.on('error', err => void this.end(err as Error))
    ws.on('close', () => void this.end(new Error('Connection Terminated')))
  }

  private async awaitNextMessage(sendMsg?: Buffer): Promise<Uint8Array> {
    const ws = this.ws
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
    this.startKeepAlive()
  }

  private startKeepAlive(): void {
    this.lastDateRecv = Date.now()
    this.keepAliveTimer = setInterval(() => {
      const diff = Date.now() - this.lastDateRecv
      if (diff > this.config.keepAliveIntervalMs + 5000) {
        void this.end(new Error('Connection was lost'))
      } else if (this.ws?.readyState === WebSocket.OPEN) {
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
      this.handleNode(decodeBinaryNode(Buffer.from(frame)))
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
      return void this.end(new Error(`server failure: ${JSON.stringify(attrs)}`))
    }

    if (tag === 'stream:error' || tag === 'xmlstreamend') {
      return void this.end(new Error('Connection Terminated by Server'))
    }

    // Pre-key upload is requested as an IQ set with xmlns="encrypt".
    if (tag === 'iq' && attrs.type === 'set' && attrs.xmlns === 'encrypt') {
      return void this.handlePreKeyUpload(node)
    }

    if (tag === 'message') {
      return void this.handleIncomingMessage(node)
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
      if (this.ws?.readyState !== WebSocket.OPEN) return
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
    if (node.attrs.lid && this.authState.creds.me) this.authState.creds.me.lid = node.attrs.lid
    this.ev.emit('connection.update', { connection: 'open' })
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

  private async handlePreKeyUpload(node: BinaryNode): Promise<void> {
    try {
      const creds = this.authState.creds
      const keys = await this.generateAndStorePreKeys(25)
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
    } catch (err) {
      void this.end(err as Error)
    }
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

  async sendMessage(jid: string, message: IMessage): Promise<string> {
    const me = this.authState.creds.me
    if (!me) throw new Error('Not authenticated')
    const id = this.generateMessageId(me.id)
    const repo = this.getRepository()
    const isGroupLike = isJidGroup(jid)

    const content: BinaryNode[] = []
    const encrypted = encodeMessage(message)
    const shouldIncludeDeviceIdentity = { value: false }

    const recipients = await this.resolveRecipients(jid, isGroupLike)
    for (const r of recipients) {
      const { nodes, included } = await this.encryptForRecipients(repo, r, encrypted, shouldIncludeDeviceIdentity)
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
    return id
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

    for (const device of recipient.devices) {
      const res = await repo.encryptMessage(device, encrypted)
      if (res.type === 'pkmsg') pkmsgFlag.value = true
      nodes.push({ tag: 'to', attrs: { jid: device }, content: [{ tag: 'enc', attrs: { v: '2', type: res.type }, content: res.ciphertext }] })
    }
    // Also deliver to our own other devices.
    for (const device of (await this.getOwnDevices()).filter(d => d !== me.id)) {
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
    const full = extractDeviceJids(parsed, me.id, me.lid ?? '', false)
    if (forceQuery) return full.map(deviceJid)
    return full.map(deviceJid)
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

  async sendImage(
    jid: string,
    image: Uint8Array,
    opts: { caption?: string; mimetype?: string; fileName?: string } = {}
  ): Promise<string> {
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
  ): Promise<string> {
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
      const authorJid = participant ?? from
      const repo = this.getRepository()

      const decryptResult = await this.decryptMessageNode(stanza, repo, authorJid)
      if (!decryptResult) return

      const message = decodeMessage(decryptResult.plaintext)
      this.ev.emit('messages.upsert', {
        messages: [{ key: { remoteJid: from, fromMe: false, id: attrs.id!, participant }, message, messageTimestamp: attrs.t ? +attrs.t : Math.floor(Date.now() / 1000) }]
      })
      void this.sendMessageAck(stanza, from, attrs.id!, participant)
    } catch (err) {
      this.config.logger.warn({ err }, 'failed to handle incoming message')
    }
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

  private async sendMessageAck(stanza: BinaryNode, from: string, id: string, participant?: string): Promise<void> {
    const attrs: Record<string, string> = { to: from, id, type: 'receipt' }
    if (participant) attrs.participant = participant
    await this.sendNode({ tag: 'ack', attrs, content: undefined }).catch(() => {})
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

  private async generatePairingKey(pairingCode: string): Promise<Buffer> {
    const salt = randomBytes(32)
    const iv = randomBytes(16)
    const key = await derivePairingCodeKey(pairingCode, salt)
    const ciphered = aesEncryptCTR(this.authState.creds.pairingEphemeralKeyPair.public, key, iv)
    return Buffer.concat([salt, iv, ciphered])
  }

  private async end(error?: Error): Promise<void> {
    if (this.closed) return
    this.closed = true

    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    if (this.qrTimer) clearTimeout(this.qrTimer)
    this.keepAliveTimer = null
    this.qrTimer = null

    const ws = this.ws
    if (ws) {
      ws.removeAllListeners()
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close()
        } catch {}
      }
    }
    this.ws = null
    this.noise = null
    const err = error ?? new Error('Connection Closed')
    // Reject in-flight queries instead of merely dropping them: a dropped
    // resolver both hangs the awaiter and keeps its closure alive until GC.
    for (const [, pending] of this.pendingResolvers) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pendingResolvers.clear()
    if (this.handshakeRejecter) {
      const reject = this.handshakeRejecter
      this.handshakeResolver = null
      this.handshakeRejecter = null
      reject(err)
    }

    this.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } })
  }

  async close(): Promise<void> {
    await this.end(new Error('Intentional close'))
    this.ev.removeAllListeners()
  }
}

export { initAuthState, initAuthCreds }
export type { AuthenticationState }
