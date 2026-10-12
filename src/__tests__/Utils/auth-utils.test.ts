import { Boom } from '@hapi/boom'
import type { AuthenticationCreds, Contact } from '../../Types'
import { assertMeId, initAuthCreds } from '../../Utils/auth-utils'

const credsWithMe = (me?: Partial<Contact>): AuthenticationCreds => ({
	...initAuthCreds(),
	me: me as Contact | undefined
})

describe('assertMeId', () => {
	it('returns me.id when authenticated', () => {
		const creds = credsWithMe({ id: '5511999999999@s.whatsapp.net' })
		expect(assertMeId(creds)).toBe('5511999999999@s.whatsapp.net')
	})

	it('throws Boom 401 when creds.me is undefined', () => {
		const creds = credsWithMe(undefined)
		try {
			assertMeId(creds)
			throw new Error('expected throw')
		} catch (err) {
			expect(err).toBeInstanceOf(Boom)
			expect((err as Boom).output.statusCode).toBe(401)
			expect((err as Error).message).toMatch(/not authenticated/)
		}
	})

	it('throws Boom 401 when me has no id', () => {
		const creds = credsWithMe({})
		expect(() => assertMeId(creds)).toThrow(/not authenticated/)
	})

	it('throws Boom 401 when me.id is empty string', () => {
		const creds = credsWithMe({ id: '' })
		expect(() => assertMeId(creds)).toThrow(/not authenticated/)
	})
})

describe('makeCacheableSignalKeyStore.get', () => {
	const makeBacking = (delayMs = 0) => {
		let gets = 0
		const store = {
			get: async (_type: string, ids: string[]) => {
				gets++
				if (delayMs) await new Promise(r => setTimeout(r, delayMs))
				return Object.fromEntries(ids.map(id => [id, { fake: id }]))
			},
			set: async () => undefined
		}

		return { store, getCalls: () => gets }
	}

	it('serves warm hits without touching the backing store', async () => {
		const { makeCacheableSignalKeyStore } = await import('../../Utils/auth-utils')
		const { store, getCalls } = makeBacking()
		const cacheable = makeCacheableSignalKeyStore(store as any)

		await cacheable.get('session', ['a'])
		const first = getCalls()
		const warm = await cacheable.get('session', ['a'])

		expect(warm.a).toEqual({ fake: 'a' })
		expect(getCalls()).toBe(first)
	})

	it('fills the cache from the store on a miss', async () => {
		const { makeCacheableSignalKeyStore } = await import('../../Utils/auth-utils')
		const { store, getCalls } = makeBacking()
		const cacheable = makeCacheableSignalKeyStore(store as any)

		const data = await cacheable.get('session', ['missing'])

		expect(data.missing).toEqual({ fake: 'missing' })
		expect(getCalls()).toBe(1)
	})

	it('collapses concurrent misses for the same key into a single store read', async () => {
		const { makeCacheableSignalKeyStore } = await import('../../Utils/auth-utils')
		const { store, getCalls } = makeBacking(20)
		const cacheable = makeCacheableSignalKeyStore(store as any)

		const results = await Promise.all(Array.from({ length: 8 }, () => cacheable.get('session', ['shared'])))

		for (const r of results) expect(r.shared).toEqual({ fake: 'shared' })
		// the mutex must serialise the fills so only the first reader hits the store
		expect(getCalls()).toBe(1)
	})
})
