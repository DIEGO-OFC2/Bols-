import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString } from '../../WABinary/generic-utils'
import type { BinaryNode } from '../../WABinary/types'

const node: BinaryNode = {
	tag: 'iq',
	attrs: { id: '1', type: 'result' },
	content: [
		{ tag: 'a', attrs: {}, content: 'first-a' },
		{ tag: 'b', attrs: {}, content: 'b' },
		{ tag: 'a', attrs: {}, content: 'second-a' }
	]
}

describe('getBinaryNodeChild', () => {
	it('returns the first child matching the tag', () => {
		expect(getBinaryNodeChild(node, 'a')).toBe((node.content as BinaryNode[])[0])
	})

	it('returns undefined when no child matches', () => {
		expect(getBinaryNodeChild(node, 'missing')).toBeUndefined()
	})

	it('returns undefined for a missing node or non-array content', () => {
		expect(getBinaryNodeChild(undefined, 'a')).toBeUndefined()
		expect(getBinaryNodeChild({ tag: 'x', attrs: {}, content: 'text' }, 'a')).toBeUndefined()
	})

	it('agrees with getBinaryNodeChildren on the first match', () => {
		expect(getBinaryNodeChild(node, 'a')).toBe(getBinaryNodeChildren(node, 'a')[0])
		expect(getBinaryNodeChild(node, 'nope')).toBe(getBinaryNodeChildren(node, 'nope')[0])
	})
})

describe('getBinaryNodeChildren', () => {
	it('returns every matching child in document order', () => {
		const matches = getBinaryNodeChildren(node, 'a')
		expect(matches).toHaveLength(2)
		expect(matches.map(c => c.content)).toEqual(['first-a', 'second-a'])
	})

	it('caches the per-tag lookup on the node', () => {
		expect(getBinaryNodeChildren(node, 'a')).toBe(getBinaryNodeChildren(node, 'a'))
		expect(getBinaryNodeChildren(node, 'absent')).toBe(getBinaryNodeChildren(node, 'absent'))
	})

	it('returns an empty array for a missing node or non-array content', () => {
		expect(getBinaryNodeChildren(undefined, 'a')).toEqual([])
		expect(getBinaryNodeChildren({ tag: 'x', attrs: {}, content: 'text' }, 'a')).toEqual([])
	})
})

describe('getBinaryNodeChildString', () => {
	it('reads the string content of the first matching child', () => {
		expect(getBinaryNodeChildString(node, 'a')).toBe('first-a')
		expect(getBinaryNodeChildString(node, 'b')).toBe('b')
	})

	it('returns undefined when the child is absent', () => {
		expect(getBinaryNodeChildString(node, 'missing')).toBeUndefined()
	})
})
