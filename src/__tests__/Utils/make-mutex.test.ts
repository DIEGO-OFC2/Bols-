import { makeKeyedMutex, makeMutex, makeTaskQueue } from '../../Utils/make-mutex'

const tick = () => new Promise(resolve => setImmediate(resolve))

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
