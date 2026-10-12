import { promisify } from 'util'
import { inflate } from 'zlib'
import * as constants from './constants'
import { jidEncode, type JidServer, WAJIDDomains } from './jid-utils'
import type { BinaryNode, BinaryNodeCodingOptions } from './types'

const inflatePromise = promisify(inflate)

export const decompressingIfRequired = async (buffer: Buffer) => {
	if (2 & buffer.readUInt8()) {
		buffer = await inflatePromise(buffer.subarray(1))
	} else {
		// nodes with no compression have a 0x00 prefix, we remove that
		buffer = buffer.subarray(1)
	}

	return buffer
}

type DecodeOpts = Pick<BinaryNodeCodingOptions, 'DOUBLE_BYTE_TOKENS' | 'SINGLE_BYTE_TOKENS' | 'TAGS'>

/**
 * Mutable cursor over the frame. The readers below take this instead of closing
 * over `buffer`/`index`, so decoding a stanza allocates one state object rather
 * than a fresh set of ~20 closures for every nested node.
 */
interface DecodeState {
	buffer: Buffer
	index: number
	opts: DecodeOpts
}

const HEX_CODE = new Uint8Array(16)
{
	const chars = '0123456789ABCDEF'
	for (let i = 0; i < 16; i++) HEX_CODE[i] = chars.charCodeAt(i)
}

const checkEOS = (s: DecodeState, length: number) => {
	if (s.index + length > s.buffer.length) {
		throw new Error('end of stream')
	}
}

const nextByte = (s: DecodeState) => s.buffer[s.index++]

const readByte = (s: DecodeState) => {
	checkEOS(s, 1)
	return nextByte(s)
}

const readBytes = (s: DecodeState, n: number) => {
	checkEOS(s, n)
	const value = s.buffer.subarray(s.index, s.index + n)
	s.index += n
	return value
}

const readStringFromChars = (s: DecodeState, length: number) => readBytes(s, length).toString('utf-8')

const readInt = (s: DecodeState, n: number, littleEndian = false) => {
	checkEOS(s, n)
	let val = 0
	for (let i = 0; i < n; i++) {
		const shift = littleEndian ? i : n - 1 - i
		val |= nextByte(s)! << (shift * 8)
	}

	return val
}

const readInt20 = (s: DecodeState) => {
	checkEOS(s, 3)
	return ((nextByte(s)! & 15) << 16) + (nextByte(s)! << 8) + nextByte(s)!
}

const unpackHex = (value: number) => {
	if (value >= 0 && value < 16) {
		return HEX_CODE[value]!
	}

	throw new Error('invalid hex: ' + value)
}

const unpackNibble = (value: number) => {
	if (value >= 0 && value <= 9) {
		return '0'.charCodeAt(0) + value
	}

	switch (value) {
		case 10:
			return '-'.charCodeAt(0)
		case 11:
			return '.'.charCodeAt(0)
		case 15:
			return '\0'.charCodeAt(0)
		default:
			throw new Error('invalid nibble: ' + value)
	}
}

const unpackByte = (TAGS: DecodeOpts['TAGS'], tag: number, value: number) => {
	if (tag === TAGS.NIBBLE_8) {
		return unpackNibble(value)
	} else if (tag === TAGS.HEX_8) {
		return unpackHex(value)
	} else {
		throw new Error('unknown tag: ' + tag)
	}
}

const readPacked8 = (s: DecodeState, tag: number) => {
	const startByte = readByte(s)!
	let value = ''

	for (let i = 0; i < (startByte & 127); i++) {
		const curByte = readByte(s)!

		value += String.fromCharCode(unpackByte(s.opts.TAGS, tag, (curByte & 0xf0) >> 4))
		value += String.fromCharCode(unpackByte(s.opts.TAGS, tag, curByte & 0x0f))
	}

	if (startByte >> 7 !== 0) {
		value = value.slice(0, -1)
	}

	return value
}

const isListTag = (TAGS: DecodeOpts['TAGS'], tag: number) => {
	return tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16
}

const readListSize = (s: DecodeState, tag: number) => {
	switch (tag) {
		case s.opts.TAGS.LIST_EMPTY:
			return 0
		case s.opts.TAGS.LIST_8:
			return readByte(s)
		case s.opts.TAGS.LIST_16:
			return readInt(s, 2)
		default:
			throw new Error('invalid tag for list size: ' + tag)
	}
}

const getTokenDouble = (s: DecodeState, index1: number, index2: number) => {
	const dict = s.opts.DOUBLE_BYTE_TOKENS[index1]
	if (!dict) {
		throw new Error(`Invalid double token dict (${index1})`)
	}

	const value = dict[index2]
	if (typeof value === 'undefined') {
		throw new Error(`Invalid double token (${index2})`)
	}

	return value
}

const readJidPair = (s: DecodeState) => {
	const i = readString(s, readByte(s)!)
	const j = readString(s, readByte(s)!)
	if (j) {
		return (i || '') + '@' + j
	}

	throw new Error('invalid jid pair: ' + i + ', ' + j)
}

const readAdJid = (s: DecodeState) => {
	const rawDomainType = readByte(s)
	const domainType = Number(rawDomainType)

	const device = readByte(s)
	const user = readString(s, readByte(s)!)

	let server: JidServer = 's.whatsapp.net' // default whatsapp server
	if (domainType === WAJIDDomains.LID) {
		server = 'lid'
	} else if (domainType === WAJIDDomains.HOSTED) {
		server = 'hosted'
	} else if (domainType === WAJIDDomains.HOSTED_LID) {
		server = 'hosted.lid'
	}

	return jidEncode(user, server, device)
}

const readFbJid = (s: DecodeState) => {
	const user = readString(s, readByte(s)!)
	const device = readInt(s, 2)
	const server = readString(s, readByte(s)!)
	return `${user}:${device}@${server}`
}

const readInteropJid = (s: DecodeState) => {
	const user = readString(s, readByte(s)!)
	const device = readInt(s, 2)
	const integrator = readInt(s, 2)

	let server = 'interop'
	const beforeServer = s.index
	try {
		server = readString(s, readByte(s)!)
	} catch (err) {
		s.index = beforeServer
	}

	return `${integrator}-${user}:${device}@${server}`
}

const readString = (s: DecodeState, tag: number): string => {
	const { SINGLE_BYTE_TOKENS, TAGS } = s.opts
	if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) {
		return SINGLE_BYTE_TOKENS[tag] || ''
	}

	switch (tag) {
		case TAGS.DICTIONARY_0:
		case TAGS.DICTIONARY_1:
		case TAGS.DICTIONARY_2:
		case TAGS.DICTIONARY_3:
			return getTokenDouble(s, tag - TAGS.DICTIONARY_0, readByte(s)!)
		case TAGS.LIST_EMPTY:
			return ''
		case TAGS.BINARY_8:
			return readStringFromChars(s, readByte(s)!)
		case TAGS.BINARY_20:
			return readStringFromChars(s, readInt20(s))
		case TAGS.BINARY_32:
			return readStringFromChars(s, readInt(s, 4))
		case TAGS.JID_PAIR:
			return readJidPair(s)
		case TAGS.FB_JID:
			return readFbJid(s)
		case TAGS.INTEROP_JID:
			return readInteropJid(s)
		case TAGS.AD_JID:
			return readAdJid(s)
		case TAGS.HEX_8:
		case TAGS.NIBBLE_8:
			return readPacked8(s, tag)
		default:
			throw new Error('invalid string with tag: ' + tag)
	}
}

const readList = (s: DecodeState, tag: number) => {
	const items: BinaryNode[] = []
	const size = readListSize(s, tag)!
	for (let i = 0; i < size; i++) {
		items.push(decodeNode(s))
	}

	return items
}

const decodeNode = (s: DecodeState): BinaryNode => {
	const { TAGS } = s.opts
	const listSize = readListSize(s, readByte(s)!)
	const header = readString(s, readByte(s)!)
	if (!listSize || !header.length) {
		throw new Error('invalid node')
	}

	const attrs: BinaryNode['attrs'] = {}
	let data: BinaryNode['content']
	if (listSize === 0 || !header) {
		throw new Error('invalid node')
	}

	// read the attributes in
	const attributesLength = (listSize - 1) >> 1
	for (let i = 0; i < attributesLength; i++) {
		const key = readString(s, readByte(s)!)
		const value = readString(s, readByte(s)!)

		attrs[key] = value
	}

	if (listSize % 2 === 0) {
		const tag = readByte(s)!
		if (isListTag(TAGS, tag)) {
			data = readList(s, tag)
		} else {
			let decoded: Buffer | string
			switch (tag) {
				case TAGS.BINARY_8:
					decoded = readBytes(s, readByte(s)!)
					break
				case TAGS.BINARY_20:
					decoded = readBytes(s, readInt20(s))
					break
				case TAGS.BINARY_32:
					decoded = readBytes(s, readInt(s, 4))
					break
				default:
					decoded = readString(s, tag)
					break
			}

			data = decoded
		}
	}

	return {
		tag: header,
		attrs,
		content: data
	}
}

export const decodeDecompressedBinaryNode = (
	buffer: Buffer,
	opts: DecodeOpts,
	indexRef: { index: number } = { index: 0 }
): BinaryNode => {
	const state: DecodeState = { buffer, index: indexRef.index, opts }
	const node = decodeNode(state)
	indexRef.index = state.index
	return node
}

export const decodeBinaryNode = async (buff: Buffer): Promise<BinaryNode> => {
	const decompBuff = await decompressingIfRequired(buff)
	return decodeDecompressedBinaryNode(decompBuff, constants)
}
