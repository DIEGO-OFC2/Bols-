/**
 * Shared helper for interop tests. They compare lightwa against a Baileys
 * reference checkout/libsignal that lives outside the repo (under /tmp or an
 * optional dev dependency). When that reference is missing the suites skip
 * instead of failing, so `npm test` stays green without it.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const BAILEYS_CANDIDATES = [
  '/tmp/wa-cross/node_modules/baileys',
  '/tmp/wa-bench/node_modules/baileys',
  '/tmp/wa-test/Baileys'
]

/** Directory of a baileys install: local node_modules first, then /tmp checkouts. */
const resolveBaileysDir = (): string | null => {
  try {
    return dirname(require.resolve('baileys/package.json'))
  } catch {
    /* not installed locally */
  }
  for (const c of BAILEYS_CANDIDATES) {
    if (existsSync(join(c, 'package.json'))) return c
  }
  return null
}

export const baileysDir = (): string | null => resolveBaileysDir()

const LIBSIGNAL_CANDIDATES = [
  '/tmp/wa-test/Baileys/node_modules/libsignal',
  '/tmp/wa-cross/node_modules/libsignal',
  '/tmp/wa-bench/node_modules/libsignal'
]

export const loadBaileys = (): any => {
  const dir = baileysDir()
  return dir ? require(dir) : null
}

/** Require a subpath inside the baileys package (e.g. WAProto/index.js). */
export const requireBaileys = (sub: string): any => {
  const dir = baileysDir()
  if (!dir) throw new Error('baileys reference not available')
  return require(join(dir, sub))
}

/** Dynamic-import a baileys subpath; null when it cannot load (e.g. native bridge). */
export const importBaileys = async (sub: string): Promise<any | null> => {
  const dir = baileysDir()
  if (!dir) return null
  try {
    return await import(join(dir, sub))
  } catch {
    return null
  }
}

export const loadLibsignal = (): any => {
  try {
    return require('libsignal')
  } catch {
    /* fall through to /tmp checkouts */
  }
  for (const c of LIBSIGNAL_CANDIDATES) {
    if (existsSync(c)) {
      try {
        return require(c)
      } catch {
        /* try next */
      }
    }
  }
  return null
}

export const baileysParent = (): string => dirname(baileysDir() ?? '/tmp/wa-bench/node_modules/baileys')

/** Print a SKIP line and exit 0 so the suite does not fail CI. */
export const skip = (what: string): never => {
  console.log(`SKIP ${what}: reference not available (install baileys/libsignal)`)
  process.exit(0)
}

