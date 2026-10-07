/**
 * Minimal async mutex, API-compatible with the parts of `async-mutex` this
 * package used (runExclusive / acquire / isLocked). Keeping it in-repo drops
 * the dependency; waiters are served in FIFO order through a promise chain.
 */
export const createMutex = () => {
	let tail: Promise<void> = Promise.resolve()
	let pending = 0

	const acquire = async (): Promise<() => void> => {
		let release!: () => void
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		const prev = tail
		tail = prev.then(() => gate)
		pending++

		await prev

		let released = false
		return () => {
			if (released) return
			released = true
			pending--
			release()
		}
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
			return pending > 0
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
