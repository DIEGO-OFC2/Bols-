import WebSocket from 'ws'
import { DEFAULT_ORIGIN } from '../../Defaults'
import { AbstractSocketClient } from './types'

/** Close code we send when tearing a connection down ourselves (RFC 6455 1000 = normal). */
const NORMAL_CLOSURE_CODE = 1000

export class WebSocketClient extends AbstractSocketClient {
	protected socket: WebSocket | null = null

	get isOpen(): boolean {
		return this.socket?.readyState === WebSocket.OPEN
	}
	get isClosed(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSED
	}
	get isClosing(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSING
	}
	get isConnecting(): boolean {
		return this.socket?.readyState === WebSocket.CONNECTING
	}

	connect() {
		if (this.socket) {
			return
		}

		const socket = new WebSocket(this.url, {
			origin: DEFAULT_ORIGIN,
			headers: this.config.options?.headers as {},
			handshakeTimeout: this.config.connectTimeoutMs,
			timeout: this.config.connectTimeoutMs,
			agent: this.config.agent
		})

		this.socket = socket
		socket.setMaxListeners(0)

		const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response']

		for (const event of events) {
			socket.on(event, (...args: unknown[]) => this.emit(event, ...args))
		}
	}

	async close() {
		const socket = this.socket
		if (!socket) {
			return
		}

		this.socket = null

		if (socket.readyState === WebSocket.CLOSED) {
			return
		}

		const closePromise = new Promise<void>(resolve => {
			// Resolve even if the peer never answers the close handshake, so `end()`
			// cannot hang a reconnect behind a half-open socket.
			const timer = setTimeout(() => resolve(), 3_000)
			socket.once('close', () => {
				clearTimeout(timer)
				resolve()
			})
		})

		if (socket.readyState === WebSocket.CONNECTING) {
			// ws throws if we close() before the handshake finished; terminate instead.
			socket.terminate()
		} else {
			socket.close(NORMAL_CLOSURE_CODE)
		}

		await closePromise
	}

	send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean {
		const socket = this.socket
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			cb?.(new Error('WebSocket is not open'))
			return false
		}

		// Guard against ws' synchronous throw when the peer is already gone.
		try {
			socket.send(str, cb)
		} catch (error) {
			cb?.(error as Error)
			return false
		}

		return true
	}
}
