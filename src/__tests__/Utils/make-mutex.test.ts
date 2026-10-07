import { createMutex, makeKeyedMutex, makeMutex, makeTaskQueue } from '../../Utils/make-mutex'

const tick = () => new Promise(resolve => setImmediate(resolve))

describe('createMutex', () => {
	it('grants the lock to one holder at a time, FIFO', async () => {
		const mutex = createMutex()
		const order: string[] = []

		const first = mutex.acquire()
		const second = mutex.acquire()

		expect(mutex.isLocked()).toBe(true)
		expect(order).toEqual([])

		const releaseFirst = await first
		order.push('first')
		releaseFirst()

		const releaseSecond = await second
		order.push('second')
		releaseSecond()

		expect(order).toEqual(['first', 'second'])
		expect(mutex.isLocked()).toBe(false)
	})

	it('runs the exclusive task and releases on throw', async () => {
		const mutex = createMutex()

		await expect(
			mutex.runExclusive(() => {
				throw new Error('boom')
			})
		).rejects.toThrow('boom')

		expect(mutex.isLocked()).toBe(false)
		await expect(mutex.runExclusive(() => 'ok')).resolves.toBe('ok')
	})

	it('ignores a double release', async () => {
		const mutex = createMutex()
		const release = await mutex.acquire()
		release()
		release()
		expect(mutex.isLocked()).toBe(false)
	})
})

describe('makeTaskQueue', () => {
	it('runs tasks serially in submission order', async () => {
		const queue = makeTaskQueue()
		const order: number[] = []

		const tasks = [1, 2, 3].map(n =>
			queue.add(async () => {
				await tick()
				order.push(n)
				return n
			})
		)

		await expect(Promise.all(tasks)).resolves.toEqual([1, 2, 3])
		expect(order).toEqual([1, 2, 3])
	})

	it('does not stall behind a rejected task', async () => {
		const queue = makeTaskQueue()
		const failed = queue.add(() => Promise.reject(new Error('boom')))
		const next = queue.add(() => 'ok')

		await expect(failed).rejects.toThrow('boom')
		await expect(next).resolves.toBe('ok')
	})

	it('propagates the task result', async () => {
		const queue = makeTaskQueue()
		await expect(queue.add(() => 42)).resolves.toBe(42)
	})
})

describe('makeMutex', () => {
	it('serializes overlapping sections', async () => {
		const mutex = makeMutex()
		const events: string[] = []

		await Promise.all([
			mutex.mutex(async () => {
				events.push('a:start')
				await tick()
				events.push('a:end')
			}),
			mutex.mutex(async () => {
				events.push('b:start')
				await tick()
				events.push('b:end')
			})
		])

		expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
	})
})

describe('makeKeyedMutex', () => {
	it('runs different keys concurrently but the same key serially', async () => {
		const mutex = makeKeyedMutex()
		const events: string[] = []

		await Promise.all([
			mutex.mutex('x', async () => {
				events.push('x1:start')
				await tick()
				events.push('x1:end')
			}),
			mutex.mutex('x', async () => {
				events.push('x2:start')
				await tick()
				events.push('x2:end')
			}),
			mutex.mutex('y', () => events.push('y'))
		])

		expect(events.indexOf('x2:start')).toBeGreaterThan(events.indexOf('x1:end'))
		expect(events).toContain('y')
	})

	it('drops the per-key entry once no one holds or waits on it', async () => {
		const mutex = makeKeyedMutex()
		await mutex.mutex('k', () => undefined)

		// Second call must still work after the first entry was cleaned up.
		await expect(mutex.mutex('k', () => 'again')).resolves.toBe('again')
	})
})
