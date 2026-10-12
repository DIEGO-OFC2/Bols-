/**
 * Minimal async mutex, API-compatible with the parts of `async-mutex` this
 * package used (runExclusive / acquire / isLocked). Keeping it in-repo drops
 * the dependency; waiters are served in FIFO order.
 *
 * `acquire` returns the release function directly when the lock is free, so the
 * uncontended path (the common one: cache fills and per-key transactions are
 * rarely concurrent) costs no promise machinery. Waiters are queued and resumed
 * in order; every caller awaits the result, so the `() => void | Promise<...>`
 * union is transparent to them.
 */
export const createMutex = () => {
	let locked = false
	const waiters: Array<() => void> = []

	const unlock = () => {
		const next = waiters.shift()
		if (next) {
			next()
		} else {
			locked = false
		}
	}

	const acquire = (): (() => void) | Promise<() => void> => {
		if (!locked) {
			locked = true
			let done = false
			return () => {
				if (done) return
				done = true
				unlock()
			}
		}

		return new Promise<() => void>(resolve => {
			waiters.push(() => {
				let done = false
				resolve(() => {
					if (done) return
					done = true
					unlock()
				})
			})
		})
	}

	return {
		acquire,
		async runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
			const release = await acquire()
			try {
				return await task()
			} finally {
				release()
			}
		},
		isLocked(): boolean {
			return locked
		}
	}
}

export type AsyncMutex = ReturnType<typeof createMutex>

export const makeMutex = () => {
	const mutex = createMutex()

	return {
		mutex<T>(code: () => Promise<T> | T): Promise<T> {
			return mutex.runExclusive(code)
		}
	}
}

export type Mutex = ReturnType<typeof makeMutex>

export const makeKeyedMutex = () => {
	const map = new Map<string, { mutex: AsyncMutex; refCount: number }>()

	return {
		async mutex<T>(key: string, task: () => Promise<T> | T): Promise<T> {
			let entry = map.get(key)

			if (!entry) {
				entry = { mutex: createMutex(), refCount: 0 }
				map.set(key, entry)
			}

			entry.refCount++

			try {
				return await entry.mutex.runExclusive(task)
			} finally {
				entry.refCount--
				// only delete it if this is still the current entry
				if (entry.refCount === 0 && map.get(key) === entry) {
					map.delete(key)
				}
			}
		}
	}
}

export type KeyedMutex = ReturnType<typeof makeKeyedMutex>

/**
 * Minimal serial task queue. Tasks run one at a time in submission order,
 * matching `p-queue({ concurrency: 1 })` without pulling its dependency tree
 * (p-timeout, eventemitter3) into the package.
 */
export const makeTaskQueue = () => {
	let tail: Promise<void> = Promise.resolve()

	return {
		add<T>(task: () => Promise<T> | T): Promise<T> {
			const run = tail.then(() => task())
			// Keep the chain alive across rejections so one failing task
			// doesn't stall the queue behind it.
			tail = run.then(
				() => undefined,
				() => undefined
			)
			return run
		}
	}
}

export type TaskQueue = ReturnType<typeof makeTaskQueue>
