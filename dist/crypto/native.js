/**
 * Optional native accelerator (native/lightwa_crypto.node).
 *
 * The addon is a small, self-contained C implementation of SHA-256 /
 * HMAC-SHA256 / HKDF-SHA256 (no OpenSSL link). It is strictly optional: build
 * it with `npm run build:native` and it is picked up automatically, otherwise
 * the pure-JS `@noble/hashes` path is used. Everything here degrades to `null`
 * rather than throwing, so a missing or stale binary never breaks the client.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
// src/crypto/native.ts and dist/crypto/native.js are both two levels below the
// package root, so one relative path covers both.
const CANDIDATES = [
    fileURLToPath(new URL('../../native/lightwa_crypto.node', import.meta.url)),
    fileURLToPath(new URL('../../../native/lightwa_crypto.node', import.meta.url))
];
const load = () => {
    for (const path of CANDIDATES) {
        if (!existsSync(path))
            continue;
        try {
            const mod = require(path);
            // Sanity-check the ABI: a stale binary must not be used silently.
            const probe = mod.sha256(Buffer.from('lightwa'));
            if (probe.length === 32)
                return mod;
        }
        catch {
            /* try next candidate */
        }
    }
    return null;
};
export const nativeCrypto = load();
export const hasNativeCrypto = nativeCrypto !== null;
//# sourceMappingURL=native.js.map