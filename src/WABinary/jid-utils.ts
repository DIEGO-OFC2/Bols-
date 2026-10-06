export const S_WHATSAPP_NET = '@s.whatsapp.net'
export const OFFICIAL_BIZ_JID = '16505361212@c.us'
export const SERVER_JID = 'server@c.us'
export const PSA_WID = '0@c.us'
export const STORIES_JID = 'status@broadcast'
export const META_AI_JID = '13135550002@c.us'

export type JidServer =
	| 'c.us'
	| 'g.us'
	| 'broadcast'
	| 's.whatsapp.net'
	| 'call'
	| 'lid'
	| 'newsletter'
	| 'bot'
	| 'hosted'
	| 'hosted.lid'

export enum WAJIDDomains {
	WHATSAPP = 0,
	LID = 1,
	HOSTED = 128,
	HOSTED_LID = 129
}

export type JidWithDevice = {
	user: string
	device?: number
}

export type FullJid = JidWithDevice & {
	server: JidServer
	domainType?: number
}

export const getServerFromDomainType = (initialServer: string, domainType?: WAJIDDomains): JidServer => {
	switch (domainType) {
		case WAJIDDomains.LID:
			return 'lid'
		case WAJIDDomains.HOSTED:
			return 'hosted'
		case WAJIDDomains.HOSTED_LID:
			return 'hosted.lid'
		case WAJIDDomains.WHATSAPP:
		default:
			return initialServer as JidServer
	}
}

export const jidEncode = (user: string | number | null, server: JidServer, device?: number, agent?: number) => {
	return `${user || ''}${!!agent ? `_${agent}` : ''}${!!device ? `:${device}` : ''}@${server}`
}

export const jidDecode = (jid: string | undefined): FullJid | undefined => {
	// todo: investigate how to implement hosted ids in this case
	if (typeof jid !== 'string') {
		return undefined
	}

	const sepIdx = jid.indexOf('@')
	if (sepIdx < 0) {
		return undefined
	}

	const server = jid.slice(sepIdx + 1)
	const userCombined = jid.slice(0, sepIdx)

	// parse user[:device][_agent] with plain slicing; indexOf-based parsing
	// avoids the intermediate arrays split() would allocate on this hot path
	let userAgent = userCombined
	let device: string | undefined
	const colonIdx = userCombined.indexOf(':')
	if (colonIdx >= 0) {
		userAgent = userCombined.slice(0, colonIdx)
		const nextColon = userCombined.indexOf(':', colonIdx + 1)
		device = nextColon >= 0 ? userCombined.slice(colonIdx + 1, nextColon) : userCombined.slice(colonIdx + 1)
	}

	let user = userAgent
	let agent: string | undefined
	const underscoreIdx = userAgent.indexOf('_')
	if (underscoreIdx >= 0) {
		user = userAgent.slice(0, underscoreIdx)
		const nextUnderscore = userAgent.indexOf('_', underscoreIdx + 1)
		agent =
			nextUnderscore >= 0 ? userAgent.slice(underscoreIdx + 1, nextUnderscore) : userAgent.slice(underscoreIdx + 1)
	}

	let domainType = WAJIDDomains.WHATSAPP
	if (server === 'lid') {
		domainType = WAJIDDomains.LID
	} else if (server === 'hosted') {
		domainType = WAJIDDomains.HOSTED
	} else if (server === 'hosted.lid') {
		domainType = WAJIDDomains.HOSTED_LID
	} else if (agent) {
		domainType = parseInt(agent)
	}

	return {
		server: server as JidServer,
		user,
		domainType,
		device: device ? +device : undefined
	}
}

/** the user portion of a jid, or undefined when there is no `@` */
const jidUser = (jid: string | undefined): string | undefined => {
	if (typeof jid !== 'string') {
		return undefined
	}

	const at = jid.indexOf('@')
	if (at < 0) {
		return undefined
	}

	const colon = jid.indexOf(':')
	const underscore = jid.indexOf('_')
	let end = at
	if (colon >= 0 && colon < end) {
		end = colon
	}

	if (underscore >= 0 && underscore < end) {
		end = underscore
	}

	return jid.slice(0, end)
}

/** is the jid a user */
export const areJidsSameUser = (jid1: string | undefined, jid2: string | undefined) => {
	if (jid1 === jid2) {
		return true
	}

	// both sides without a user portion compare equal (undefined === undefined)
	return jidUser(jid1) === jidUser(jid2)
}

/** is the jid Meta AI */
export const isJidMetaAI = (jid: string | undefined) => jid?.endsWith('@bot')
/** is the jid a PN user */
export const isPnUser = (jid: string | undefined) => jid?.endsWith('@s.whatsapp.net')
/** is the jid a LID */
export const isLidUser = (jid: string | undefined) => jid?.endsWith('@lid')
/** is the jid a broadcast */
export const isJidBroadcast = (jid: string | undefined) => jid?.endsWith('@broadcast')
/** is the jid a group */
export const isJidGroup = (jid: string | undefined) => jid?.endsWith('@g.us')
/** is the jid the status broadcast */
export const isJidStatusBroadcast = (jid: string) => jid === 'status@broadcast'
/** is the jid a newsletter */
export const isJidNewsletter = (jid: string | undefined) => jid?.endsWith('@newsletter')
/** is the jid a hosted PN */
export const isHostedPnUser = (jid: string | undefined) => jid?.endsWith('@hosted')
/** is the jid a hosted LID */
export const isHostedLidUser = (jid: string | undefined) => jid?.endsWith('@hosted.lid')

const botRegexp = /^1313555\d{4}$|^131655500\d{2}$/

export const isJidBot = (jid: string | undefined) => jid && botRegexp.test(jid.split('@')[0]!) && jid.endsWith('@c.us')

export const jidNormalizedUser = (jid: string | undefined) => {
	const result = jidDecode(jid)
	if (!result) {
		return ''
	}

	const { user, server } = result
	return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : (server as JidServer))
}

export const transferDevice = (fromJid: string, toJid: string) => {
	const fromDecoded = jidDecode(fromJid)
	const deviceId = fromDecoded?.device || 0
	const { server, user } = jidDecode(toJid)!
	return jidEncode(user, server, deviceId)
}
