/**
 * USync: the device-list query used before sending. For each recipient user we
 * ask the server which devices exist and which LID it maps to, so we know how
 * many Signal sessions to create and which addresses to encrypt to.
 */
import {
  S_WHATSAPP_NET,
  WAJIDDomains,
  jidDecode,
  jidNormalizedUser,
  type FullJid
} from '../wabinary/jid.js'
import type { BinaryNode } from '../wabinary/types.js'
import { getBinaryNodeChild, getBinaryNodeChildren } from '../wabinary/generic-utils.js'

export interface DeviceListData {
  id: number
  keyIndex?: number
  isHosted?: boolean
}

export interface USyncDeviceResult {
  id: string
  lid?: string
  devices: DeviceListData[]
}

/** Build the `<iq xmlns="usync">` node requesting device lists for `jids`. */
export const buildUSyncDeviceQuery = (jids: string[], sid: string): BinaryNode => ({
  tag: 'iq',
  attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' },
  content: [
    {
      tag: 'usync',
      attrs: { context: 'message', mode: 'query', sid, last: 'true', index: '0' },
      content: [
        {
          tag: 'query',
          attrs: {},
          content: [
            { tag: 'devices', attrs: { version: '2' } },
            { tag: 'lid', attrs: {} }
          ]
        },
        {
          tag: 'list',
          attrs: {},
          content: jids.map(jid => ({ tag: 'user', attrs: { jid } }))
        }
      ]
    }
  ]
})

/** Parse the device + lid information from a USync result. */
export const parseUSyncDeviceResult = (result: BinaryNode | undefined): USyncDeviceResult[] => {
  const usync = getBinaryNodeChild(result, 'usync')
  const list = getBinaryNodeChild(usync, 'list')
  if (!list) return []

  const out: USyncDeviceResult[] = []
  for (const user of getBinaryNodeChildren(list, 'user')) {
    const id = user.attrs.jid
    if (!id) continue

    const devicesNode = getBinaryNodeChild(user, 'devices')
    const lidNode = getBinaryNodeChild(user, 'lid')
    const devices: DeviceListData[] = []
    const deviceList = getBinaryNodeChild(devicesNode, 'device-list')
    for (const d of getBinaryNodeChildren(deviceList, 'device')) {
      devices.push({
        id: +d.attrs.id!,
        keyIndex: d.attrs['key-index'] ? +d.attrs['key-index'] : undefined,
        isHosted: d.attrs['is_hosted'] === 'true'
      })
    }

    out.push({ id, lid: lidNode?.attrs.val, devices })
  }
  return out
}

/**
 * Expand USync results into concrete device JIDs, excluding our own device and
 * dropping entries the server would reject (non-zero device with no key index).
 */
export const extractDeviceJids = (
  results: USyncDeviceResult[],
  myJid: string,
  myLid: string,
  excludeZeroDevices: boolean
): FullJid[] => {
  const my = jidDecode(myJid)!
  const myLidUser = jidDecode(myLid)?.user
  const out: FullJid[] = []

  for (const userResult of results) {
    const decoded = jidDecode(userResult.id)!
    let { user, server, domainType } = decoded
    for (const { id: device, keyIndex, isHosted } of userResult.devices) {
      if (excludeZeroDevices && device === 0) continue
      if ((my.user === user || myLidUser === user) && my.device === device) continue
      if (device !== 0 && keyIndex === undefined) continue
      if (isHosted) {
        domainType = domainType === WAJIDDomains.LID ? WAJIDDomains.HOSTED_LID : WAJIDDomains.HOSTED
      }
      out.push({ user, server, domainType, device })
    }
  }
  return out
}

/** Convert a FullJid device descriptor back into a JID string. */
export const deviceJid = (j: FullJid): string => {
  const server = j.server === 'c.us' ? 's.whatsapp.net' : j.server
  const user = j.domainType && j.domainType !== WAJIDDomains.WHATSAPP ? `${j.user}_${j.domainType}` : j.user
  return `${user}:${j.device ?? 0}@${server}`
}

export { jidNormalizedUser }
