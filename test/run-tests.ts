import { spawnSync } from 'node:child_process'

const suites = [
  'test/proto-test.ts',
  'test/connection-test.ts',
  'test/crypto-test.ts',
  'test/handshake-test.ts',
  'test/send-test.ts',
  'test/pairing-test.ts',
  'test/signal-cross-test.ts',
  'test/group-cross-test.ts',
  'test/message-cross-test.ts',
  'test/media-cross-test.ts',
  'test/compat-test.ts',
  'test/native-crypto-test.ts',
  'test/repository-test.ts'
]

let failed = 0
for (const suite of suites) {
  const r = spawnSync('node', ['--import', 'tsx', suite], { stdio: 'inherit' })
  if (r.status !== 0) failed++
}

if (failed) {
  console.error(`\n${failed}/${suites.length} suites failed`)
  process.exit(1)
}
console.log(`\nall ${suites.length} suites passed`)
