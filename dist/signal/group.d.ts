interface SenderKeyDistribution {
    id: number;
    iteration: number;
    chainKey: Buffer;
    signingKey: Buffer;
}
export declare const encodeSenderKeyDistribution: (m: SenderKeyDistribution) => Buffer;
export declare const decodeSenderKeyDistribution: (buf: Uint8Array) => SenderKeyDistribution;
interface SenderMessageKeyState {
    iteration: number;
    seed: string;
}
interface SenderKeyState {
    keyId: number;
    chainIteration: number;
    chainSeed: Buffer;
    signingPublic: Buffer;
    signingPrivate?: Buffer;
    messageKeys: SenderMessageKeyState[];
}
export declare class SenderKeyRecord {
    private states;
    static deserialize(data: any): SenderKeyRecord;
    serialize(): object;
    isEmpty(): boolean;
    getState(keyId?: number): SenderKeyState | undefined;
    addState(id: number, iteration: number, chainKey: Uint8Array, signingPublic: Uint8Array): void;
    setState(id: number, iteration: number, chainKey: Uint8Array, signing: {
        public: Buffer;
        private: Buffer;
    }): void;
}
export interface SenderKeyStore {
    loadSenderKey(name: string): Promise<SenderKeyRecord>;
    storeSenderKey(name: string, record: SenderKeyRecord): Promise<void>;
}
export declare const senderKeyName: (group: string, senderId: string, deviceId: number) => string;
/** serialized DistributionMessage: [version][proto], used inside an Skdm. */
export declare const buildSenderKeyDistribution: (store: SenderKeyStore, name: string) => Promise<{
    record: SenderKeyRecord;
    serialized: Buffer;
}>;
export declare const processSenderKeyDistribution: (store: SenderKeyStore, name: string, serialized: Uint8Array) => Promise<void>;
export declare const hasSenderKey: (store: SenderKeyStore, name: string) => Promise<boolean>;
/** Encrypt with the existing sender key. Returns the serialized SenderKeyMessage. */
export declare const encryptGroupMessage: (store: SenderKeyStore, name: string, plaintext: Uint8Array) => Promise<Buffer>;
export declare const decryptGroupMessage: (store: SenderKeyStore, name: string, data: Uint8Array) => Promise<Buffer>;
export {};
//# sourceMappingURL=group.d.ts.map