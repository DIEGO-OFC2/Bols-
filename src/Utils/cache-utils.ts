import { LRUCache } from 'lru-cache'
import type { PossiblyExtendedCacheStore } from '../Types'

type CacheValue = object

export type BoundedCacheStore = PossiblyExtendedCacheStore &
	Required<Pick<PossiblyExtendedCacheStore, 'mget' | 'mset' | 'mdel' | 'close'>>

/**
 * A cache store that enforces both a TTL and a maximum number of entries.
 *
 * The socket's default caches are plain TTL maps: entries expire after the TTL
 * but nothing stops the map from growing while they're alive. A session that
 * stays connected for days and keeps seeing new chats, users and groups would
 * then hold every entry it ever inserted. Bounding the entry count makes the
 * memory ceiling independent of how many distinct keys the session touches;
 * evicted entries are simply re-fetched when needed again.
 */
export const makeBoundedCache = (max: number, ttlMs: number): BoundedCacheStore => {
	const cache = new LRUCache<string, CacheValue>({
		max,
		ttl: ttlMs,
		updateAgeOnGet: true
	})

	return {
		get: <T>(key: string) => cache.get(key) as T | undefined,
		set: <T>(key: string, value: T) => {
			cache.set(key, value as unknown as CacheValue)
		},
		del: (key: string) => {
			cache.delete(key)
		},
		flushAll: () => {
			cache.clear()
		},
		close: () => {
			cache.clear()
		},
		mget: <T>(keys: string[]) => {
			const result: Record<string, T | undefined> = {}
			for (const key of keys) {
				result[key] = cache.get(key) as T | undefined
			}

			return result as unknown as Promise<Record<string, T | undefined>>
		},
		mset: <T>(entries: { key: string; value: T }[]) => {
			for (const { key, value } of entries) {
				cache.set(key, value as unknown as CacheValue)
			}
		},
		mdel: (keys: string[]) => {
			for (const key of keys) {
				cache.delete(key)
			}
		}
	}
}

/**
 * A TTL- and entry-capped string set.
 *
 * `Set` has no eviction strategy, so a long-lived session that keeps inserting
 * distinct keys holds every one of them for the process lifetime. The cap bounds
 * that memory: with a TTL an LRU is used (it can expire entries lazily), and
 * without one a native Set is reset wholesale when it passes the cap.
 */
export const makeCappedSet = (max: number, ttlMs = 0) => {
	// No TTL means a pure membership structure (the event-buffer dedup set), which
	// is exactly what a native Set gives us. The LRU alternative pays an object
	// allocation, a Map bookkeeping update and an eviction-list splice on every
	// add/has; on a large history sync (tens of thousands of chats/contacts/
	// messages) that dominated the whole consolidation. Reset the Set wholesale
	// once it passes the cap: `clear` is O(n) but amortised over `max` inserts it
	// is O(1) per insert, and a key that falls out of the set only causes
	// redundant absorption work downstream, never a dropped or duplicated event.
	if (ttlMs <= 0) {
		const live = new Set<string>()

		return {
			add(key: string): void {
				if (live.size >= max) {
					live.clear()
				}

				live.add(key)
			},
			has(key: string): boolean {
				return live.has(key)
			},
			delete(key: string): void {
				live.delete(key)
			},
			clear(): void {
				live.clear()
			},
			get size(): number {
				return live.size
			},
			values(): IterableIterator<string> {
				return live.values()
			},
			[Symbol.iterator](): IterableIterator<string> {
				return live.values()
			}
		}
	}

	const store = new LRUCache<string, true>({ max, ttl: ttlMs })

	return {
		add(key: string): void {
			store.set(key, true)
		},
		has(key: string): boolean {
			return store.has(key)
		},
		delete(key: string): void {
			store.delete(key)
		},
		clear(): void {
			store.clear()
		},
		get size(): number {
			return store.size
		},
		values(): IterableIterator<string> {
			return store.keys()
		},
		[Symbol.iterator](): IterableIterator<string> {
			return store.keys()
		}
	}
}
