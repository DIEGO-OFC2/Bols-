import { TAGS, WAJIDDomains, type FullJid } from './types.js'
export type { FullJid }

export const S_WHATSAPP_NET = '@s.whatsapp.net'
export const OFFICIAL_BIZ_JID = '16505361212@c.us'
export const SERVER_JID = 'server@c.us'
export const STORIES_JID = 'status@broadcast'

export const jidEncode = (user: string | number | null, server: string, device?: number, agent?: number): string =>
  `${user || ''}${agent ? `_${agent}` : ''}${device ? `:${device}` : ''}@${server}`

export const jidDecode = (jid: string | undefined): FullJid | undefined => {
  const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1
  if (sepIdx < 0) return undefined

  const server = jid!.slice(sepIdx + 1)
  const userCombined = jid!.slice(0, sepIdx)
  const colonIdx = userCombined.indexOf(':')
  const device = colonIdx >= 0 ? userCombined.slice(colonIdx + 1) : undefined
  const userAgent = colonIdx >= 0 ? userCombined.slice(0, colonIdx) : userCombined
  const underscoreIdx = userAgent.indexOf('_')
  const user = underscoreIdx >= 0 ? userAgent.slice(0, underscoreIdx) : userAgent
  const agent = underscoreIdx >= 0 ? userAgent.slice(underscoreIdx + 1) : undefined

  let domainType: number = WAJIDDomains.WHATSAPP
  if (server === 'lid') domainType = WAJIDDomains.LID
  else if (server === 'hosted') domainType = WAJIDDomains.HOSTED
  else if (server === 'hosted.lid') domainType = WAJIDDomains.HOSTED_LID
  else if (agent) domainType = parseInt(agent, 10)

  return { server, user, domainType, device: device ? +device : undefined }
}

export const areJidsSameUser = (a?: string, b?: string) => jidDecode(a)?.user === jidDecode(b)?.user
export const isJidMetaAI = (jid?: string) => !!jid?.endsWith('@bot')
export const isPnUser = (jid?: string) => !!jid?.endsWith('@s.whatsapp.net')
export const isLidUser = (jid?: string) => !!jid?.endsWith('@lid')
export const isJidBroadcast = (jid?: string) => !!jid?.endsWith('@broadcast')
export const isJidGroup = (jid?: string) => !!jid?.endsWith('@g.us')
export const isJidStatusBroadcast = (jid?: string) => jid === 'status@broadcast'
export const isJidNewsletter = (jid?: string) => !!jid?.endsWith('@newsletter')

export const jidNormalizedUser = (jid?: string): string => {
  const result = jidDecode(jid)
  if (!result) return ''
  const { user, server } = result
  return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : server)
}

/** A compiled matcher for the many JIDs that end in `@x`. */
const JID_DOMAIN_CACHE = new Map<string, (jid: string) => boolean>()
export const isJidDomain = (domain: string) => {
  let fn = JID_DOMAIN_CACHE.get(domain)
  if (!fn) {
    const suffix = `@${domain}`
    fn = (jid: string) => jid.endsWith(suffix)
    JID_DOMAIN_CACHE.set(domain, fn)
  }
  return fn
}

export { TAGS, WAJIDDomains }
