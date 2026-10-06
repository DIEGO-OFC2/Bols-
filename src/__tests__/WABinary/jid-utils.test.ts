import { areJidsSameUser, jidDecode, jidNormalizedUser } from '../../WABinary/jid-utils'

describe('jidDecode', () => {
	it('parses a plain user jid', () => {
		expect(jidDecode('1234567890@s.whatsapp.net')).toEqual({
			server: 's.whatsapp.net',
			user: '1234567890',
			domainType: 0,
			device: undefined
		})
	})

	it('parses device and agent suffixes', () => {
		expect(jidDecode('1234567890_1:5@s.whatsapp.net')).toEqual({
			server: 's.whatsapp.net',
			user: '1234567890',
			domainType: 1,
			device: 5
		})
	})

	it('drops extra colon segments after the device', () => {
		expect(jidDecode('123:4:5@s.whatsapp.net')?.device).toBe(4)
	})

	it('resolves the server domain type for lid and hosted', () => {
		expect(jidDecode('999:3@lid')?.domainType).toBe(1)
		expect(jidDecode('999@hosted')?.domainType).toBe(128)
		expect(jidDecode('999@hosted.lid')?.domainType).toBe(129)
	})

	it('returns undefined without an @ sign or a non-string', () => {
		expect(jidDecode(undefined)).toBeUndefined()
		expect(jidDecode('no-at-sign')).toBeUndefined()
	})
})

describe('areJidsSameUser', () => {
	it('ignores device and agent suffixes', () => {
		expect(areJidsSameUser('123:5@s.whatsapp.net', '123@s.whatsapp.net')).toBe(true)
		expect(areJidsSameUser('123_1@s.whatsapp.net', '123:9@s.whatsapp.net')).toBe(true)
	})

	it('compares identical strings without decoding', () => {
		expect(areJidsSameUser('no-at-sign', 'no-at-sign')).toBe(true)
	})

	it('treats two jids without a user portion as equal', () => {
		expect(areJidsSameUser(undefined, 'no-at-sign')).toBe(true)
	})

	it('distinguishes different users', () => {
		expect(areJidsSameUser('123@s.whatsapp.net', '456@s.whatsapp.net')).toBe(false)
	})
})

describe('jidNormalizedUser', () => {
	it('strips device and agent and maps c.us to s.whatsapp.net', () => {
		expect(jidNormalizedUser('123_1:5@c.us')).toBe('123@s.whatsapp.net')
	})

	it('returns an empty string for an undecodable jid', () => {
		expect(jidNormalizedUser('no-at-sign')).toBe('')
	})
})
