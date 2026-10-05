/**
 * A deliberately tiny emitter. Node's EventEmitter allows unlimited listeners
 * and retains them; here we cap and remove eagerly to avoid listener leaks on
 * reconnect (a common memory sink in long-lived socket clients).
 */
export class Emitter {
    listeners = new Map();
    on(event, listener) {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(listener);
        return this;
    }
    off(event, listener) {
        this.listeners.get(event)?.delete(listener);
        return this;
    }
    once(event, listener) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            listener(...args);
        };
        return this.on(event, wrapper);
    }
    emit(event, ...args) {
        const set = this.listeners.get(event);
        if (!set?.size)
            return false;
        for (const listener of set) {
            try {
                listener(...args);
            }
            catch {
                // A listener must not break the socket loop.
            }
        }
        return true;
    }
    removeAllListeners(event) {
        if (event === undefined)
            this.listeners.clear();
        else
            this.listeners.delete(event);
        return this;
    }
}
//# sourceMappingURL=emitter.js.map