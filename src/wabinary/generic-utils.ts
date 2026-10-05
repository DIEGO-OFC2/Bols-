import type { BinaryNode } from './types.js'

export const getBinaryNodeChildren = (node: BinaryNode | undefined, childTag: string): BinaryNode[] => {
  if (!node || !Array.isArray(node.content)) return []
  const out: BinaryNode[] = []
  for (const child of node.content) {
    if (child.tag === childTag) out.push(child)
  }
  return out
}

export const getBinaryNodeChild = (node: BinaryNode | undefined, childTag: string): BinaryNode | undefined =>
  getBinaryNodeChildren(node, childTag)[0]

export const getAllBinaryNodeChildren = (node: BinaryNode): BinaryNode[] =>
  Array.isArray(node.content) ? node.content : []

export const getBinaryNodeChildBuffer = (node: BinaryNode | undefined, childTag: string): Uint8Array | undefined => {
  const content = getBinaryNodeChild(node, childTag)?.content
  return content instanceof Uint8Array ? content : undefined
}

export const getBinaryNodeChildString = (node: BinaryNode | undefined, childTag: string): string | undefined => {
  const content = getBinaryNodeChild(node, childTag)?.content
  if (content instanceof Uint8Array) return Buffer.from(content).toString('utf8')
  if (typeof content === 'string') return content
  return undefined
}

export const getBinaryNodeChildUInt = (node: BinaryNode, childTag: string, length: number): number | undefined => {
  const buf = getBinaryNodeChildBuffer(node, childTag)
  if (!buf) return undefined
  let out = 0
  for (let i = 0; i < length; i++) out = 256 * out + buf[i]!
  return out
}
