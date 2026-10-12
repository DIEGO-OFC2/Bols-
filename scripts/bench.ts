/**
 * Head-to-head benchmark: this fork vs a checkout of WhiskeySockets/Baileys.
 *
 *   npx tsx scripts/bench.ts [path-to-upstream-checkout]
 *
 * The upstream checkout needs its own dependencies installed (`npm install`)
 * so its modules can resolve protobufjs, @cacheable/node-cache, etc. When the
 * path is missing the script still runs the fork half and prints the setup hint.
 */
import { existsSync } from 'fs'
import { join } from 'path'
import pino from 'pino'
import type { BinaryNode } from '../src/WABinary/types'

const UPSTREAM = process.argv[2] || process.env.UPSTREAM_DIR || '/tmp/upstream'
const logger = pino({ level: 'silent' })

const fmt = (ms: number) => `${ms.toFixed(1)} ms`
const ratio = (slow: number, fast: number) => `${(slow / fast).toFixed(2)}x`
const row = (label: string, a: number, b: number) =>
	console.log(`  ${label.padEnd(26)} upstream ${fmt(a).padStart(10)}   fork ${fmt(b).padStart(10)}   -> ${ratio(a, b)}`)

async function loadUpstream<T>(rel: string): Promise<T | undefined> {
	if (!existsSync(join(UPSTREAM, rel))) return undefined
	try {
		return (await import(join(UPSTREAM, rel))) as T
	} catch (err) {
		console.log(`  (skipping upstream "${rel}": ${(err as Error).message.split('\n')[0]})`)
		return undefined
	}
}

const best = async (fn: () => unknown, rounds = 5) => {
	let ms = Infinity
	for (let r = 0; r < rounds; r++) {
		const t0 = performance.now()
		await fn()
		ms = Math.min(ms, performance.now() - t0)
	}

	return ms
}

const message = (i: number) => ({
	key: { remoteJid: '1234@s.whatsapp.net', fromMe: false, id: `MSG${i}` },
	message: { conversation: `hello ${i}` },
	messageTimestamp: 1
})

const stanza = (i: number): BinaryNode => ({
	tag: 'message',
	attrs: {
		id: `3EB0${i.toString(16).toUpperCase()}`,
		from: `1555123${(i % 9999).toString().padStart(4, '0')}@s.whatsapp.net`,
		t: '1700000000',
		type: 'text',
		notify: 'Alice',
		category: 'peer'
	},
	content: [{ tag: 'enc', attrs: { v: '2', type: 'msg' }, content: Buffer.alloc(180, i & 0xff) }]
})

async function main() {
	const { makeEventBuffer } = await import('../src/Utils/event-buffer')
	const { encodeBinaryNode } = await import('../src/WABinary/encode')
	const { decodeBinaryNode } = await import('../src/WABinary/decode')
	const { decodeMessageNode } = await import('../src/Utils/decode-wa-message')
	const { getContentType, normalizeMessageContent } = await import('../src/Utils/messages')

	const upBuffer = await loadUpstream<any>('src/Utils/event-buffer.ts')
	const upDecode = await loadUpstream<any>('src/WABinary/decode.ts')
	const upDecodeMsg = await loadUpstream<any>('src/Utils/decode-wa-message.ts')
	const upContentType = await loadUpstream<any>('src/Utils/messages.ts')

	console.log('\n=== messages.upsert burst while buffering (history-sync shape) ===')
	{
		const N = 4000
		const run = async (make: (l: unknown) => any) => {
			const buf = make(logger)
			buf.buffer()
			return best(() => {
				for (let i = 0; i < N; i++) buf.emit('messages.upsert', { messages: [message(i)], type: 'notify' })
			})
		}

		const fork = await run(makeEventBuffer)
		if (upBuffer) {
			const up = await run(upBuffer.makeEventBuffer)
			row(`${N} upserts`, up, fork)
		} else {
			console.log(`  fork ${fmt(fork)} for ${N} upserts (upstream not available)`)
		}
	}

	console.log('\n=== binary node decode ===')
	{
		const N = 20000
		const bufs = Array.from({ length: N }, (_, i) => encodeBinaryNode(stanza(i)))
		const fork = await best(async () => {
			for (const b of bufs) await decodeBinaryNode(b)
		})
		if (upDecode) {
			const up = await best(async () => {
				for (const b of bufs) await upDecode.decodeBinaryNode(b)
			})
			row(`${N} stanzas`, up, fork)
		} else {
			console.log(`  fork ${fmt(fork)} for ${N} stanzas (upstream not available)`)
		}
	}

	console.log('\n=== decodeMessageNode (per-message key/chat/author derivation) ===')
	{
		const N = 200_000
		const nodes = Array.from({ length: N }, (_, i) => stanza(i))
		const meId = '5511999999999@s.whatsapp.net'
		const meLid = '123456789012345@lid'
		const fork = await best(() => {
			for (const n of nodes) decodeMessageNode(n, meId, meLid)
		})
		if (upDecodeMsg) {
			const up = await best(() => {
				for (const n of nodes) upDecodeMsg.decodeMessageNode(n, meId, meLid)
			})
			row(`${N} calls`, up, fork)
		} else {
			console.log(`  fork ${fmt(fork)} for ${N} calls (upstream not available)`)
		}
	}

	console.log('\n=== getContentType (content-type lookup per message) ===')
	{
		const N = 1_000_000
		const content = { extendedTextMessage: { text: 'hi' }, messageContextInfo: {} } as any
		const fork = await best(() => {
			for (let i = 0; i < N; i++) getContentType(content)
		})
		if (upContentType) {
			const up = await best(() => {
				for (let i = 0; i < N; i++) upContentType.getContentType(content)
			})
			row(`${N} calls`, up, fork)
		} else {
			console.log(`  fork ${fmt(fork)} for ${N} calls (upstream not available)`)
		}
	}

	console.log('\n=== normalizeMessageContent (unwrap ephemeral/view-once) ===')
	{
		const N = 1_000_000
		const wrapped = { ephemeralMessage: { message: { viewOnceMessage: { message: { conversation: 'hi' } } } } } as any
		const fork = await best(() => {
			for (let i = 0; i < N; i++) normalizeMessageContent(wrapped)
		})
		if (upContentType) {
			const up = await best(() => {
				for (let i = 0; i < N; i++) upContentType.normalizeMessageContent(wrapped)
			})
			row(`${N} calls`, up, fork)
		} else {
			console.log(`  fork ${fmt(fork)} for ${N} calls (upstream not available)`)
		}
	}

	if (!upBuffer) {
		console.log(
			`\nSet up the upstream comparison with:\n` +
				`  git clone --depth 1 https://github.com/WhiskeySockets/Baileys ${UPSTREAM}\n` +
				`  cd ${UPSTREAM} && npm install\n`
		)
	}

	await memorySection()
}

/**
 * Upstream keeps the history dedup set as a plain `Set` and its internal caches
 * as TTL-only node-cache instances, so a long-lived session accumulates every
 * distinct key it ever saw. This section feeds the same key stream into an
 * unbounded `Set` and into the fork's capped set to show the memory delta.
 * Needs `node --expose-gc`; skipped otherwise.
 */
async function memorySection() {
	const gc = (global as { gc?: () => void }).gc
	if (!gc) {
		console.log('\n=== memory under sustained distinct keys (skipped: run with node --expose-gc) ===')
		return
	}

	const { makeCappedSet } = await import('../src/Utils/cache-utils')
	const N = 200_000
	const key = (i: number) => `1555123${i}@s.whatsapp.net:MSG${i}`

	// upstream shape: plain Set, no eviction
	gc()
	gc()
	let base = process.memoryUsage().heapUsed
	const unbounded = new Set<string>()
	for (let i = 0; i < N; i++) unbounded.add(key(i))
	gc()
	gc()
	const unboundedMB = (process.memoryUsage().heapUsed - base) / 1048576

	// fork shape: capped set
	base = process.memoryUsage().heapUsed
	const bounded = makeCappedSet(5000)
	for (let i = 0; i < N; i++) bounded.add(key(i))
	gc()
	gc()
	const boundedMB = (process.memoryUsage().heapUsed - base) / 1048576

	console.log('\n=== memory after inserting %d distinct keys ===', N)
	console.log(`  upstream plain Set (unbounded)  ${unboundedMB.toFixed(2)} MB   entries ${unbounded.size}`)
	console.log(`  fork makeCappedSet(5000)        ${boundedMB.toFixed(2)} MB   entries ${bounded.size}`)
	console.log(`  -> fork holds ${(unboundedMB / Math.max(boundedMB, 0.01)).toFixed(1)}x less heap and stays bounded`)
}

main().catch(err => {
	console.error(err)
	process.exit(1)
})
