# AGENTS.md

`lightwa` is a from-scratch, memory-frugal WhatsApp Web protocol client in
TypeScript (ESM, Node >= 20). It is protocol-compatible with Baileys v7
(`/tmp/wa-test/Baileys`, rc14) for the linking handshake.

## Layout

- `src/wabinary/` — binary node codec. `tokens.ts` holds the wire token
  dictionaries; `encode.ts`/`decode.ts` are the codec; `constants.ts` has TAGS.
- `src/socket/` — `noise-handler.ts` (Noise_XX handshake) and `client.ts`
  (wire lifecycle: connect, keep-alive, node routing, QR + pairing code).
- `src/crypto/` — Curve (native X25519 keygen/shared secret via OpenSSL,
  XEdDSA via @noble/curves), HKDF, AES-GCM/CTR. `native.ts` loads the optional
  C accelerator with a JS fallback.
- `native/` — `hkdf.c`, the optional N-API addon (SHA-256 / HMAC / HKDF). Built
  by `scripts/build-native.mjs` into `native/lightwa_crypto.node` (gitignored).
- `src/signal/` — `session.ts` (Double Ratchet, SessionBuilder/Cipher/Record),
  `group.ts` (sender keys), `repository.ts` (binds sessions to the key store),
  `lid-mapping.ts`.
- `src/proto/` — hand-rolled protobuf readers/writers. `bytes.ts` holds the
  fast growable-buffer primitives used on the message hot path; `writer.ts` is
  the older generic codec still used by `client-payload.ts`/`handshake.ts`.
  `message.ts` is the `Message` codec.
- `src/media/` — HKDF media keys, AES-CBC encrypt/decrypt, `node:https` upload.
- `src/usync/` — device-list query build/parse and device-JID extraction.
- `src/utils/` — auth state, connection validation, generic helpers.
- `test/` — integration harnesses, run by `npm test`.
- `example/memory-profile.ts` — heap-plateau probe (`npm run profile`).
- `bench/compare.mjs` — head-to-head microbenchmark vs baileys (`npm run bench`).

## Commands

- `npm run typecheck` — tsc, no emit.
- `npm run build:native` — compiles `native/hkdf.c` to a `.node` addon. Optional;
  exits 0 with a note if no compiler / Node headers are found.
- `npm test` — runs `test/run-tests.ts`, which spawns every `test/*-test.ts`.
- `npm run example` — live connect; prints QR and RSS/heap. Needs outbound
  network to web.whatsapp.com.
- `npm run profile` — 20k ratchet-cycle heap probe; expects a plateau
  (`node --expose-gc`).
- `npm run bench` — microbenchmark vs baileys; needs `baileys` (dev dep).

## Invariants and gotchas

- Token dictionary ordering is wire-critical. `SINGLE_BYTE_TOKENS` must match
  the reference exactly. Do not hand-edit `src/wabinary/tokens.ts`; regenerate
  it from `constants.ts` of the reference checkout. The original hand-written
  table had drifted and broke real-server interop.
- `decodeBinaryNode` expects the full frame including the leading
  compression/dictionary flag byte. Codec cross-checks must pass the reference
  bytes unstripped.
- Noise: `client.ts` must pass a freshly generated `ephemeralKeyPair` into
  `NoiseHandler`. Reusing the static noise key pair makes ECDH secrets diverge.
- Frame advance uses `subarray` to avoid copying socket buffers.
- Live server behavior matches rc14, not the published npm `baileys` build —
  prefer the source checkout when cross-validating.
- Interop suites load `baileys`/`libsignal` from `node_modules` (installed as
  dev deps) or a `/tmp` checkout, and print `SKIP` when neither exists. The npm
  `baileys` build is ESM with an import-only export map and pulls a Rust WASM
  bridge for `getMediaKeys`; load those subpaths with dynamic `import`, not
  `require`, and skip if the native bridge is unavailable.
- Prefer native `crypto` over JS where it is byte-identical: X25519 keygen and
  shared secrets use OpenSSL (`generateKeyPairSync('x25519')` and
  `diffieHellman`); media keys and HKDF use `@noble/hashes` `hkdf` (byte-
  identical to `crypto.hkdfSync` but ~1.8x faster). XEdDSA has no native
  equivalent, so it stays on @noble/curves.
- `hmacSign`/`sha256` route through the optional native addon when present
  (~2x `node:crypto` for the short inputs the Signal ratchet uses), falling back
  to `node:crypto`. The ratchet's per-step chain HMACs, the `deriveSecrets`
  scratch buffer and the fixed info/zero constants in `signal/session.ts` exist
  to keep the per-message path allocation-light — keep them in place, and keep
  `signal/group.ts` importing the shared constants instead of re-allocating.
  Verify any ratchet change with `test/signal-cross-test.ts` and `npm run bench`.
- The message hot path must stay allocation-light: use the `ByteWriter` /
  `ByteReader` from `proto/bytes.ts` (growable buffer, pooled nested writers,
  zero-copy `subarray` reads) rather than the generic `ProtoWriter`/`ProtoReader`,
  which allocates a `Buffer` per varint byte. Verify any codec change with
  `test/message-cross-test.ts` (byte-identical to WAProto) and `npm run bench`.
- The native addon is strictly optional and must never be a hard dependency.
  `src/crypto/native.ts` returns `null` on any failure (missing binary, bad ABI,
  no `dlopen`) and every call site must fall back to `@noble/hashes`. The addon
  itself `dlopen`s `libcrypto` for SHA-NI and silently uses its bundled C SHA-256
  if unavailable. Never link OpenSSL at build time — the addon must stay
  dependency-free so `npm run build:native` works on a bare toolchain.
  `test/native-crypto-test.ts` cross-checks every primitive against OpenSSL and
  skips cleanly when the addon is not built.
- `Curve.verify` strips a leading `0x05` Signal type byte from 33-byte public
  keys. Callers pass either form; missing this made every group sender-key
  signature fail.
- `Curve.verify` has a native OpenSSL fast path: XEdDSA signatures are Ed25519
  signatures over the key's Montgomery→Edwards form with the key sign bit packed
  into the top bit of `s`. `verify` derives that form and re-parses it into a
  `KeyObject` once per key (both are ~30µs, key-only operations) and caches the
  result in a bounded `edwardsKeyCache` (512 entries, evict-oldest); the per
  message cost is then a single `cryptoVerify` with the **full 64-byte** `R || s`
  (passing only the 32-byte `s` silently fails every time). The noble scalar path
  is the fallback when the key fails to parse. This is ~9k ops/s and dominates
  the group-decrypt hot path — do not reintroduce a per-message key parse.
- Group decrypt advances the sender chain lazily via `getSenderKeySeed`, which
  retains skipped message keys for out-of-order delivery. That list is capped at
  `MAX_MESSAGE_KEYS` on every advance — remove the cap and a peer that keeps
  jumping the counter forward grows the list unbounded.
- Signal group cipher stepping must mirror libsignal exactly: when encrypting,
  the iteration used is `chainIteration === 0 ? 0 : chainIteration + 1`, and the
  chain advances to that iteration before deriving the message key.
- The `Message` protobuf is hand-coded per media type because field numbers
  differ between image/video/audio/document/sticker (see `src/proto/message.ts`
  `MEDIA_FIELDS`). Verify against `WAProto/WAProto.proto` before editing.
- Auth creds must carry `nextPreKeyId` and `firstUnuploadedPreKeyId`; they are
  persisted alongside pre-keys so an upload can resume after a restart.
- The protobuf writer skips `undefined` values, so optional fields can be passed
  without branching — but nested writers must not be constructed from undefined
  (guard first).
- `src/compat/baileys.ts` is the drop-in layer for hosts that `require("baileys")`
  / `await import("baileys")` (e.g. the V3 bot). The default export is
  `makeWASocket`; it re-exports the helpers V3 destructures (`useMultiFileAuthState`,
  `makeCacheableSignalKeyStore`, `generateWAMessage*`, `prepareWAMessageMedia`,
  `downloadContentFromMessage`, `Browsers`, `DisconnectReason`, `delay`, ...).
  When broadening the public surface, keep this file and `src/index.ts` in sync.
- `SocketConfig.browser` accepts the Baileys tuple form `[os, browser, version]`;
  the compat layer passes it through unchanged.
- `makeWASocket` opens the websocket itself (like Baileys); hosts never call
  `WAClient.connect()`. `connect()` builds the `NoiseHandler` but the transport
  keys only exist after the handshake, so `requestPairingCode` awaits the
  `transportReady` gate (resolved right after `noise.finishInit`, rejected in
  `end()`). Skipping that wait is what produced `noise not initialised`.
- `end()` installs a no-op `ws.on('error')` after `removeAllListeners()`: `ws`
  emits an async error when a still-connecting socket is closed, which would
  otherwise crash the host with an unhandled `'error'` event.
- Generic USync lives in `src/usync/index.ts`: `buildUSyncQuery`/`parseUSyncResult`
  plus `WAClient.executeUSyncQuery(protocols, users)`. `onWhatsApp` (contact
  protocol) and `fetchStatus` (status protocol) are built on it; the send path
  uses the device/lid-specific `buildUSyncDeviceQuery` instead.
- `WAClient` exposes the full Baileys v7 socket surface V3 consumes, including
  `sendAlbum`, `sendReact`, `logout`, `onWhatsApp`, `presenceSubscribe`,
  `readMessages`, `sendReceipts`, `updateProfileName`, `updateProfileStatus`,
  `fetchPrivacySettings`, `fetchStatus`, `getBusinessProfile`. `test/compat-test.ts`
  asserts these exist; extend that list when adding methods.

## Tests

Each harness prints `N/M ... passed` and sets `process.exitCode` on failure.
`npm test` aggregates them. When adding a suite, append it to the `suites`
array in `test/run-tests.ts`.
