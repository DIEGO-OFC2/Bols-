import * as constants from './constants'
import { type FullJid, jidDecode } from './jid-utils'
import type { BinaryNode, BinaryNodeCodingOptions } from './types'

const utf8Encoder = new TextEncoder()
const utf8Scratch = new Uint8Array(2048)

/**
 * Growable byte sink. Writes into a single Buffer with a cursor instead of
 * pushing byte-by-byte into a number[] and copying at the end; `set` copies
 * whole slices in one memcpy.
 */
class ByteWriter {
	private buf: Buffer
	private pos = 0

	constructor(size = 4096) {
		this.buf = Buffer.allocUnsafe(size)
	}

	private ensure(extra: number) {
		const needed = this.pos + extra
		if (needed <= this.buf.length) {
			return
		}

		let size = this.buf.length * 2
		while (size < needed) {
			size *= 2
		}

		const next = Buffer.allocUnsafe(size)
		this.buf.copy(next, 0, 0, this.pos)
		this.buf = next
	}

	pushByte(value: number) {
		this.ensure(1)
		this.buf[this.pos++] = value & 0xff
	}

	pushBytes(bytes: Uint8Array) {
		this.ensure(bytes.length)
		this.buf.set(bytes, this.pos)
		this.pos += bytes.length
	}

	reset() {
		this.pos = 0
	}

	toBuffer(): Buffer {
		return Buffer.from(this.buf.subarray(0, this.pos))
	}
}

type EncodeOpts = Pick<BinaryNodeCodingOptions, 'TAGS' | 'TOKEN_MAP'>

// The writers below are module-level and take the sink explicitly. Closing over
// it (as this file used to) rebuilt the whole set for every nested node, so an
// N-node stanza paid N closure-set allocations.
const pushInt = (w: ByteWriter, value: number, n: number, littleEndian = false) => {
	for (let i = 0; i < n; i++) {
		const curShift = littleEndian ? i : n - 1 - i
		w.pushByte((value >> (curShift * 8)) & 0xff)
	}
}

const pushBytes = (w: ByteWriter, bytes: Uint8Array | Buffer | number[]) => {
	// numbers are rare (tag tuples); typed arrays go straight through memcpy
	if (Array.isArray(bytes)) {
		w.pushBytes(Uint8Array.from(bytes))
	} else {
		w.pushBytes(bytes)
	}
}

const pushInt16 = (w: ByteWriter, value: number) => {
	w.pushByte((value >> 8) & 0xff)
	w.pushByte(value & 0xff)
}

const pushInt20 = (w: ByteWriter, value: number) => {
	w.pushByte((value >> 16) & 0x0f)
	w.pushByte((value >> 8) & 0xff)
	w.pushByte(value & 0xff)
}

const writeByteLength = (w: ByteWriter, TAGS: EncodeOpts['TAGS'], length: number) => {
	if (length >= 4294967296) {
		throw new Error('string too large to encode: ' + length)
	}

	if (length >= 1 << 20) {
		w.pushByte(TAGS.BINARY_32)
		pushInt(w, length, 4) // 32 bit integer
	} else if (length >= 256) {
		w.pushByte(TAGS.BINARY_20)
		pushInt20(w, length)
	} else {
		w.pushByte(TAGS.BINARY_8)
		w.pushByte(length)
	}
}

const writeStringRaw = (w: ByteWriter, TAGS: EncodeOpts['TAGS'], str: string) => {
	let bytes: Uint8Array
	if (str.length <= 512) {
		// encodeInto reuses a scratch buffer, avoiding a Buffer alloc per string
		const { written } = utf8Encoder.encodeInto(str, utf8Scratch)
		bytes = utf8Scratch.subarray(0, written)
	} else {
		bytes = utf8Encoder.encode(str)
	}

	writeByteLength(w, TAGS, bytes.length)
	pushBytes(w, bytes)
}

const packNibble = (char: string) => {
	switch (char) {
		case '-':
			return 10
		case '.':
			return 11
		case '\0':
			return 15
		default:
			if (char >= '0' && char <= '9') {
				return char.charCodeAt(0) - '0'.charCodeAt(0)
			}

			throw new Error(`invalid byte for nibble "${char}"`)
	}
}

const packHex = (char: string) => {
	if (char >= '0' && char <= '9') {
		return char.charCodeAt(0) - '0'.charCodeAt(0)
	}

	if (char >= 'A' && char <= 'F') {
		return 10 + char.charCodeAt(0) - 'A'.charCodeAt(0)
	}

	if (char >= 'a' && char <= 'f') {
		return 10 + char.charCodeAt(0) - 'a'.charCodeAt(0)
	}

	if (char === '\0') {
		return 15
	}

	throw new Error(`Invalid hex char "${char}"`)
}

const writePackedBytes = (w: ByteWriter, TAGS: EncodeOpts['TAGS'], str: string, type: 'nibble' | 'hex') => {
	if (str.length > TAGS.PACKED_MAX) {
		throw new Error('Too many bytes to pack')
	}

	w.pushByte(type === 'nibble' ? TAGS.NIBBLE_8 : TAGS.HEX_8)

	let roundedLength = Math.ceil(str.length / 2.0)
	if (str.length % 2 !== 0) {
		roundedLength |= 128
	}

	w.pushByte(roundedLength)
	const packFunction = type === 'nibble' ? packNibble : packHex

	const packBytePair = (v1: string, v2: string) => {
		const result = (packFunction(v1) << 4) | packFunction(v2)
		return result
	}

	const strLengthHalf = Math.floor(str.length / 2)
	for (let i = 0; i < strLengthHalf; i++) {
		w.pushByte(packBytePair(str[2 * i]!, str[2 * i + 1]!))
	}

	if (str.length % 2 !== 0) {
		w.pushByte(packBytePair(str[str.length - 1]!, '\x00'))
	}
}

const isNibble = (TAGS: EncodeOpts['TAGS'], str?: string) => {
	if (!str || str.length > TAGS.PACKED_MAX) {
		return false
	}

	for (let i = 0; i < str.length; i++) {
		const char = str[i]!
		const isInNibbleRange = char >= '0' && char <= '9'
		if (!isInNibbleRange && char !== '-' && char !== '.') {
			return false
		}
	}

	return true
}

const isHex = (TAGS: EncodeOpts['TAGS'], str?: string) => {
	if (!str || str.length > TAGS.PACKED_MAX) {
		return false
	}

	for (let i = 0; i < str.length; i++) {
		const char = str[i]!
		const isInNibbleRange = char >= '0' && char <= '9'
		if (!isInNibbleRange && !(char >= 'A' && char <= 'F')) {
			return false
		}
	}

	return true
}

const writeJid = (w: ByteWriter, opts: EncodeOpts, { domainType, device, user, server }: FullJid) => {
	if (typeof device !== 'undefined') {
		w.pushByte(opts.TAGS.AD_JID)
		w.pushByte(domainType || 0)
		w.pushByte(device || 0)
		writeString(w, opts, user)
	} else {
		w.pushByte(opts.TAGS.JID_PAIR)
		if (user.length) {
			writeString(w, opts, user)
		} else {
			w.pushByte(opts.TAGS.LIST_EMPTY)
		}

		writeString(w, opts, server)
	}
}

const writeString = (w: ByteWriter, opts: EncodeOpts, str?: string) => {
	const { TAGS, TOKEN_MAP } = opts
	if (str === undefined || str === null) {
		w.pushByte(TAGS.LIST_EMPTY)
		return
	}

	if (str === '') {
		writeStringRaw(w, TAGS, str)
		return
	}

	const tokenIndex = TOKEN_MAP[str]
	if (tokenIndex) {
		if (typeof tokenIndex.dict === 'number') {
			w.pushByte(TAGS.DICTIONARY_0 + tokenIndex.dict)
		}

		w.pushByte(tokenIndex.index)
	} else if (isNibble(TAGS, str)) {
		writePackedBytes(w, TAGS, str, 'nibble')
	} else if (isHex(TAGS, str)) {
		writePackedBytes(w, TAGS, str, 'hex')
	} else if (str.indexOf('@') >= 0) {
		// Only strings carrying a jid separator can decode as a jid; plain
		// message text skips the decode scan entirely.
		const decodedJid = jidDecode(str)
		if (decodedJid) {
			writeJid(w, opts, decodedJid)
		} else {
			writeStringRaw(w, TAGS, str)
		}
	} else {
		writeStringRaw(w, TAGS, str)
	}
}

const writeListStart = (w: ByteWriter, TAGS: EncodeOpts['TAGS'], listSize: number) => {
	if (listSize === 0) {
		w.pushByte(TAGS.LIST_EMPTY)
	} else if (listSize < 256) {
		w.pushByte(TAGS.LIST_8)
		w.pushByte(listSize)
	} else {
		w.pushByte(TAGS.LIST_16)
		pushInt16(w, listSize)
	}
}

// Reused across calls: encoding is synchronous and non-reentrant (encrypted
// payloads arrive pre-encoded), so one growable sink avoids a 4 KB allocation
// per stanza on the send path. `toBuffer` still copies, so the returned buffer
// never aliases the scratch.
const sharedWriter = new ByteWriter()

export const encodeBinaryNode = (node: BinaryNode, opts: EncodeOpts = constants): Buffer => {
	const writer = sharedWriter
	writer.reset()
	writer.pushByte(0)
	encodeBinaryNodeInner(node, opts, writer)
	return writer.toBuffer()
}

const encodeBinaryNodeInner = ({ tag, attrs, content }: BinaryNode, opts: EncodeOpts, writer: ByteWriter): void => {
	const { TAGS } = opts

	if (!tag) {
		throw new Error('Invalid node: tag cannot be undefined')
	}

	// for..in (over Object.keys) avoids materialising a key array for every node;
	// attrs are plain objects built by the decoder/message code, never class instances.
	let attrCount = 0
	if (attrs) {
		for (const key in attrs) {
			if (typeof attrs[key] === 'string') {
				attrCount++
			}
		}
	}

	writeListStart(writer, TAGS, 2 * attrCount + 1 + (typeof content !== 'undefined' ? 1 : 0))
	writeString(writer, opts, tag)

	if (attrs) {
		for (const key in attrs) {
			const value = attrs[key]
			if (typeof value === 'string') {
				writeString(writer, opts, key)
				writeString(writer, opts, value)
			}
		}
	}

	if (typeof content === 'string') {
		writeString(writer, opts, content)
	} else if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
		writeByteLength(writer, TAGS, content.length)
		pushBytes(writer, content)
	} else if (Array.isArray(content)) {
		// Count valid children up-front without allocating the filtered array: the
		// common case (a freshly built stanza) is all-valid, so this skips a
		// throwaway array and closure on every node that has children.
		let validCount = 0
		let hasInvalid = false
		for (const item of content) {
			if (item && (item.tag || Buffer.isBuffer(item) || item instanceof Uint8Array || typeof item === 'string')) {
				validCount++
			} else {
				hasInvalid = true
			}
		}

		writeListStart(writer, TAGS, validCount)
		if (hasInvalid) {
			for (const item of content) {
				if (item && (item.tag || Buffer.isBuffer(item) || item instanceof Uint8Array || typeof item === 'string')) {
					encodeBinaryNodeInner(item, opts, writer)
				}
			}
		} else {
			for (const item of content) {
				encodeBinaryNodeInner(item, opts, writer)
			}
		}
	} else if (typeof content === 'undefined') {
		// do nothing
	} else {
		throw new Error(`invalid children for header "${tag}": ${content} (${typeof content})`)
	}
}
