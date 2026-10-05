import type { BrowserDescription } from './browser-utils.js'

export enum CompanionWebClientType {
  UNKNOWN = 0,
  CHROME = 1,
  EDGE = 2,
  FIREFOX = 3,
  IE = 4,
  OPERA = 5,
  SAFARI = 6,
  ELECTRON = 7,
  UWP = 8,
  OTHER_WEB_CLIENT = 9
}

const BROWSER_TO_COMPANION: Record<string, CompanionWebClientType> = {
  Chrome: CompanionWebClientType.CHROME,
  Edge: CompanionWebClientType.EDGE,
  Firefox: CompanionWebClientType.FIREFOX,
  IE: CompanionWebClientType.IE,
  Opera: CompanionWebClientType.OPERA,
  Safari: CompanionWebClientType.SAFARI
}

export const getCompanionWebClientType = ([os, browserName]: BrowserDescription): CompanionWebClientType => {
  if (browserName === 'Desktop') {
    return os === 'Windows' ? CompanionWebClientType.UWP : CompanionWebClientType.ELECTRON
  }
  return BROWSER_TO_COMPANION[browserName] ?? CompanionWebClientType.OTHER_WEB_CLIENT
}

export const getCompanionPlatformId = (browser: BrowserDescription): string =>
  getCompanionWebClientType(browser).toString()

/** Data encoded in a linked-device QR code. */
export const buildPairingQRData = (
  ref: string,
  noiseKeyB64: string,
  identityKeyB64: string,
  advB64: string,
  browser: BrowserDescription
): string =>
  'https://wa.me/settings/linked_devices#' +
  [ref, noiseKeyB64, identityKeyB64, advB64, getCompanionPlatformId(browser)].join(',')
