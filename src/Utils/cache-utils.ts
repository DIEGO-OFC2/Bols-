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
 * distinct keys holds every one of them for the process lifetime. Pairing a
 * `Set` with an LRU cap keeps membership O(1) while the cap bounds memory.
 */
export const makeCappedSet = (max: number, ttlMs: number) => {
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
