export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'ptt' | 'gif';
export declare const MEDIA_PATH_MAP: Record<MediaType, string>;
export interface MediaKeys {
    iv: Buffer;
    cipherKey: Buffer;
    macKey: Buffer;
}
/** Derive the IV / cipher key / MAC key from a 32-byte media key. */
export declare const getMediaKeys: (mediaKey: Uint8Array, mediaType: MediaType) => MediaKeys;
export interface EncryptedMedia {
    mediaKey: Buffer;
    fileSha256: Buffer;
    fileEncSha256: Buffer;
    fileLength: number;
    /** ciphertext followed by the 10-byte MAC, i.e. the object to upload. */
    encrypted: Buffer;
    mac: Buffer;
}
/** Encrypt a whole media buffer. `plaintext` is not retained. */
export declare const encryptMedia: (plaintext: Uint8Array, mediaType: MediaType) => EncryptedMedia;
/** Decrypt a downloaded media object (ciphertext + MAC). */
export declare const decryptMedia: (encrypted: Uint8Array, mediaKey: Uint8Array, mediaType: MediaType) => Buffer;
export interface MediaConnInfo {
    hosts: {
        hostname: string;
        maxContentLengthBytes: number;
    }[];
    auth: string;
    ttl: number;
    fetchDate: Date;
}
export interface UploadResult {
    url: string;
    directPath: string;
}
/**
 * Upload an encrypted object with `node:https`. We deliberately avoid fetch so
 * the body is not copied into memory by undici.
 */
export declare const uploadToHost: (hostname: string, mediaPath: string, encSha256: Uint8Array, data: Buffer, auth: string) => Promise<UploadResult>;
/** Upload to the first working host, refreshing the connection on failure. */
export declare const uploadMedia: (encrypted: Buffer, encSha256: Uint8Array, mediaType: MediaType, getConn: (force: boolean) => Promise<MediaConnInfo>) => Promise<UploadResult>;
//# sourceMappingURL=index.d.ts.map