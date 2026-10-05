export type Listener = (...args: any[]) => void

/**
 * A deliberately tiny emitter. Node's EventEmitter allows unlimited listeners
 * and retains them; here we cap and remove eagerly to avoid listener leaks on
 * reconnect (a common memory sink in long-lived socket clients).
 */
export class Emitter<Events extends Record<string, Listener>> {
  private listeners = new Map<keyof Events, Set<Listener>>()

  on<K extends keyof Events>(event: K, listener: Events[K]): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  off<K extends keyof Events>(event: K, listener: Events[K]): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  once<K extends keyof Events>(event: K, listener: Events[K]): this {
    const wrapper = (...args: any[]) => {
      this.off(event, wrapper as Events[K])
      ;(listener as Listener)(...args)
    }
    return this.on(event, wrapper as Events[K])
  }

  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): boolean {
    const set = this.listeners.get(event)
    if (!set?.size) return false
    for (const listener of set) {
      try {
        listener(...args)
      } catch {
        // A listener must not break the socket loop.
      }
    }
    return true
  }

  removeAllListeners(event?: keyof Events): this {
    if (event === undefined) this.listeners.clear()
    else this.listeners.delete(event)
    return this
  }
}
