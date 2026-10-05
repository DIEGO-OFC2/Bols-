export type Listener = (...args: any[]) => void;
/**
 * A deliberately tiny emitter. Node's EventEmitter allows unlimited listeners
 * and retains them; here we cap and remove eagerly to avoid listener leaks on
 * reconnect (a common memory sink in long-lived socket clients).
 */
export declare class Emitter<Events extends Record<string, Listener>> {
    private listeners;
    on<K extends keyof Events>(event: K, listener: Events[K]): this;
    off<K extends keyof Events>(event: K, listener: Events[K]): this;
    once<K extends keyof Events>(event: K, listener: Events[K]): this;
    emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): boolean;
    removeAllListeners(event?: keyof Events): this;
}
//# sourceMappingURL=emitter.d.ts.map