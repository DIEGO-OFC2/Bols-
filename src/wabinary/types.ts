/** The in-memory representation of a WhatsApp binary node ("stanza"). */
export interface BinaryNode {
  tag: string
  attrs: Record<string, string>
  content?: BinaryNode[] | string | Uint8Array
}

export const TAGS = {
  LIST_EMPTY: 0,
  DICTIONARY_0: 236,
  DICTIONARY_1: 237,
  DICTIONARY_2: 238,
  DICTIONARY_3: 239,
  INTEROP_JID: 245,
  FB_JID: 246,
  AD_JID: 247,
  LIST_8: 248,
  LIST_16: 249,
  JID_PAIR: 250,
  HEX_8: 251,
  BINARY_8: 252,
  BINARY_20: 253,
  BINARY_32: 254,
  NIBBLE_8: 255,
  PACKED_MAX: 127
} as const

export const WAJIDDomains = {
  WHATSAPP: 0,
  LID: 1,
  HOSTED: 128,
  HOSTED_LID: 129
} as const

export interface FullJid {
  user: string
  server: string
  device?: number
  agent?: number
  domainType?: number
}
