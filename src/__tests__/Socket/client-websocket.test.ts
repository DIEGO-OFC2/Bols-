import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import type { SocketConfig } from '../../Types'

class MockWebSocket extends EventEmitter {
	static OPEN = 1
	static CONNECTING = 0
	static CLOSING = 2
	static CLOSED = 3

	readyState = MockWebSocket.CONNECTING
	closedWith: number | undefined
	terminated = false
	sent: unknown[] = []

	constructor(
		public url: unknown,
		public options: unknown
	) {
		super()
	}

	setMaxListeners(): this {
		return this
	}

	send(data: unknown, cb?: (err?: Error) => void): void {
		if (this.readyState !== MockWebSocket.OPEN) {
			throw new Error('WebSocket is not open: readyState ' + this.readyState)
		}

		this.sent.push(data)
		cb?.()
	}

	close(code?: number): void {
		this.closedWith = code
		this.readyState = MockWebSocket.CLOSED
		this.emit('close')
	}

	terminate(): void {
		this.terminated = true
		this.readyState = MockWebSocket.CLOSED
	}

	open(): void {
		this.readyState = MockWebSocket.OPEN
		this.emit('open')
	}
}

jest.unstable_mockModule('ws', () => ({ default: MockWebSocket }))

const { WebSocketClient } = await import('../../Socket/Client/websocket')

const makeConfig = () => ({ connectTimeoutMs: 1_000, options: {} }) as unknown as SocketConfig

const getSocket = (client: InstanceType<typeof WebSocketClient>) =>
	(client as unknown as { socket: MockWebSocket | null }).socket!

describe('WebSocketClient', () => {
	it('does not reconnect when connect() is called twice', () => {
		const client = new WebSocketClient(new URL('wss://example.test'), makeConfig())

		client.connect()
		const first = getSocket(client)
		client.connect()

		expect(getSocket(client)).toBe(first)
	})

	it('reports a failed send when the socket is not open', () => {
		const client = new WebSocketClient(new URL('wss://example.test'), makeConfig())
		client.connect()

		const cb = jest.fn()
		const ok = client.send(new Uint8Array([1]), cb)

		expect(ok).toBe(false)
		expect(cb).toHaveBeenCalledWith(expect.any(Error))
	})

	it('forwards sends once the socket is open', () => {
		const client = new WebSocketClient(new URL('wss://example.test'), makeConfig())
		client.connect()
		getSocket(client).open()

		expect(client.isOpen).toBe(true)
		expect(client.send(new Uint8Array([1]))).toBe(true)
		expect(getSocket(client).sent).toHaveLength(1)
	})

	it('terminates a still-connecting socket instead of throwing on close', async () => {
		const client = new WebSocketClient(new URL('wss://example.test'), makeConfig())
		client.connect()
		const socket = getSocket(client)

		await client.close()

		expect(socket.terminated).toBe(true)
		expect(client.isClosed).toBe(true)
	})

	it('closes an open socket with a normal close code', async () => {
		const client = new WebSocketClient(new URL('wss://example.test'), makeConfig())
		client.connect()
		const socket = getSocket(client)
		socket.open()

		await client.close()

		expect(socket.closedWith).toBe(1000)
	})

	it('resolves close() even if the peer never answers the close handshake', async () => {
		jest.useFakeTimers()
		try {
			const client = new WebSocketClient(new URL('wss://example.test'), makeConfig())
			client.connect()
			const socket = getSocket(client)
			socket.open()
			// Swallow the close handshake so only the fallback timer can resolve it.
			socket.close = (code?: number) => {
				socket.closedWith = code
			}

			const pending = client.close()
			await jest.advanceTimersByTimeAsync(3_000)

			await expect(pending).resolves.toBeUndefined()
		} finally {
			jest.useRealTimers()
		}
	})

	it('close() is a no-op when never connected', async () => {
		const client = new WebSocketClient(new URL('wss://example.test'), makeConfig())
		await expect(client.close()).resolves.toBeUndefined()
	})
})
