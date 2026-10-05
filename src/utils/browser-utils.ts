export type BrowserDescription = [os: string, browser: string, version: string]

export const Browsers = {
  ubuntu: (browser: string): BrowserDescription => ['Ubuntu', browser, '22.04.4'],
  macOS: (browser: string): BrowserDescription => ['Mac OS', browser, '14.4.1'],
  baileys: (browser: string): BrowserDescription => ['Baileys', browser, '0.1.0'],
  windows: (browser: string): BrowserDescription => ['Windows', browser, '10.0.22631'],
  /** A generic desktop browser used when no OS is specified. */
  desktop: (browser: string): BrowserDescription => ['Desktop', browser, '1.0.0']
}
