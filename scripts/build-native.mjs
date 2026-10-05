/**
 * Builds the optional native crypto addon (native/lightwa_crypto.node).
 *
 * This is deliberately dependency-free: it shells out to the system C compiler
 * with the Node headers and produces a plain N-API shared object. There is no
 * node-gyp, no OpenSSL link, and no network access. If a compiler or the Node
 * headers cannot be found the script exits 0 and prints a note, leaving the
 * pure-JS (noble) path in use.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(root, 'native', 'lightwa_crypto.node')
const src = join(root, 'native', 'hkdf.c')

const firstExisting = (paths) => paths.find((p) => p && existsSync(p))

const findIncludeDir = () => {
  if (process.env.NODE_INCLUDE) return process.env.NODE_INCLUDE
  const execDir = dirname(process.execPath)
  return firstExisting([
    '/acp-node/include/node',
    '/usr/include/node',
    '/usr/local/include/node',
    join(execDir, '..', 'include', 'node'),
    join(execDir, 'include', 'node'),
    join(process.env.HOME ?? '', '.cache', 'node-gyp', process.versions.node, 'include', 'node')
  ])
}

const which = (bin) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const findCompiler = () => [process.env.CC, 'cc', 'gcc', 'clang'].filter(Boolean).find(which)

const includeDir = findIncludeDir()
const cc = findCompiler()

if (!cc || !includeDir) {
  console.log(
    `[native] skipped: ${!cc ? 'no C compiler found' : 'node headers not found (set NODE_INCLUDE)'}. ` +
      'Using the pure-JS crypto path.'
  )
  process.exit(0)
}

mkdirSync(join(root, 'native'), { recursive: true })

const darwin = process.platform === 'darwin'
const args = [
  '-shared',
  '-fPIC',
  '-O3',
  `-I${includeDir}`,
  '-DNAPI_VERSION=8',
  '-DNODE_GYP_MODULE_NAME=lightwa_crypto',
  '-o',
  out,
  src
]
if (darwin) {
  args.splice(1, 0, '-bundle', '-undefined', 'dynamic_lookup')
} else {
  args.push('-Wl,-z,noexecstack', '-ldl')
}

try {
  execFileSync(cc, args, { stdio: 'inherit' })
  console.log(`[native] built ${out}`)
} catch (error) {
  console.log('[native] build failed, continuing with the pure-JS crypto path')
  console.log(error.message)
}
process.exit(0)
