/**
 * Usage example plus a small memory probe.
 *
 * Run with:  npm run example
 *
 * Connecting to a live WhatsApp server requires an outbound connection to
 * web.whatsapp.com. This demo prints the QR / pairing code and reports RSS and
 * heap usage so the frugality of the client can be observed directly.
 */
import { WAClient, initAuthState, Browsers } from '../src/index.js'

const auth = initAuthState()

const client = new WAClient({
  auth,
  browser: Browsers.macOS('Chrome'),
  // Send just the essentials on first link.
  syncFullHistory: false
})

const fmt = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

client.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
  if (qr) {
    console.log('\nScan this QR in WhatsApp > Linked devices:\n')
    console.log(qr)
    console.log()
  }

  if (connection === 'open') {
    console.log('connected as', client.getUser()?.id)
    console.log('auth state still holds creds:', Boolean(auth.creds.noiseKey))
  }

  if (connection === 'close') {
    console.log('closed:', lastDisconnect?.error?.message)
  }

  const mem = process.memoryUsage()
  console.log(`[mem] rss=${fmt(mem.rss)} heapUsed=${fmt(mem.heapUsed)}`)
})

client.connect()

// Ask for a pairing code instead of the QR, e.g.:
//   const code = await client.requestPairingCode('15551234567')
//   console.log('pairing code:', code)

process.on('SIGINT', async () => {
  await client.close()
  process.exit(0)
})
