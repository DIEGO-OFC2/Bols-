import { Mutex as AsyncMutex } from 'async-mutex'

export const makeMutex = () => {
	const mutex = new AsyncMutex()

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
				entry = { mutex: new AsyncMutex(), refCount: 0 }
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
