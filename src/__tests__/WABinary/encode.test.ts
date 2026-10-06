import { decodeBinaryNode } from '../../WABinary/decode'
import { encodeBinaryNode } from '../../WABinary/encode'
import type { BinaryNode } from '../../WABinary/types'

describe('encodeBinaryNode', () => {
	it('round-trips a node through encode/decode', async () => {
		const node: BinaryNode = {
			tag: 'message',
			attrs: { to: '1234567890@s.whatsapp.net', id: 'ABCD1234', type: 'text' },
			content: 'hola'
		}

		const decoded = await decodeBinaryNode(encodeBinaryNode(node))
		expect(decoded.tag).toBe('message')
		expect(decoded.attrs).toEqual(node.attrs)
		expect(Buffer.from(decoded.content as Buffer).toString('utf-8')).toBe('hola')
	})

	it('preserves binary content length across the 20/32 bit boundaries', async () => {
		for (const size of [0, 1, 255, 256, 65535, 65536]) {
			const payload = Buffer.alloc(size, 7)
			const decoded = await decodeBinaryNode(encodeBinaryNode({ tag: 'x', attrs: {}, content: payload }))
			expect((decoded.content as Buffer).length).toBe(size)
		}
	})

	it('keeps a stable byte layout for a known node', () => {
		const encoded = encodeBinaryNode({
			tag: 'a',
			attrs: { k: 'n' },
			content: '123456789012345'
		})

		// leading 0x00, LIST_8(0xf8) 0x04, tag 'a', key 'k', nibble-packed value
		expect(encoded.toString('hex')).toBe('00f804fc0161fc016bfc016eff88123456789012345f')
	})
})
