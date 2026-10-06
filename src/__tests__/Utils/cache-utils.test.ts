import { makeBoundedCache } from '../../Utils/cache-utils'

describe('makeBoundedCache', () => {
	it('evicts the least recently used entry once max is exceeded', async () => {
		const cache = makeBoundedCache(2, 60_000)

		await cache.set('a', { v: 1 })
		await cache.set('b', { v: 2 })
		await cache.get('a') // touch a so b becomes the least recently used
		await cache.set('c', { v: 3 })

		expect(await cache.get('a')).toEqual({ v: 1 })
		expect(await cache.get('b')).toBeUndefined()
		expect(await cache.get('c')).toEqual({ v: 3 })
	})

	it('expires entries after the ttl', async () => {
		const cache = makeBoundedCache(10, 20)

		await cache.set('a', { v: 1 })
		expect(await cache.get('a')).toEqual({ v: 1 })

		await new Promise(resolve => setTimeout(resolve, 40))
		expect(await cache.get('a')).toBeUndefined()
	})

	it('supports mget/mset/mdel and flushAll', async () => {
		const cache = makeBoundedCache(10, 60_000)

		await cache.mset([
			{ key: 'a', value: { v: 1 } },
			{ key: 'b', value: { v: 2 } }
		])
		expect(await cache.mget(['a', 'b', 'c'])).toEqual({ a: { v: 1 }, b: { v: 2 }, c: undefined })

		await cache.mdel(['a'])
		expect(await cache.get('a')).toBeUndefined()

		await cache.flushAll()
		expect(await cache.get('b')).toBeUndefined()
	})
})
