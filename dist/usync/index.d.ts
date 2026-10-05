/**
 * USync: the device-list query used before sending. For each recipient user we
 * ask the server which devices exist and which LID it maps to, so we know how
 * many Signal sessions to create and which addresses to encrypt to.
 */
import { jidNormalizedUser, type FullJid } from '../wabinary/jid.js';
import type { BinaryNode } from '../wabinary/types.js';
export interface DeviceListData {
    id: number;
    keyIndex?: number;
    isHosted?: boolean;
}
export interface USyncDeviceResult {
    id: string;
    lid?: string;
    devices: DeviceListData[];
}
/** Build the `<iq xmlns="usync">` node requesting device lists for `jids`. */
export declare const buildUSyncDeviceQuery: (jids: string[], sid: string) => BinaryNode;
/** Parse the device + lid information from a USync result. */
export declare const parseUSyncDeviceResult: (result: BinaryNode | undefined) => USyncDeviceResult[];
/**
 * Expand USync results into concrete device JIDs, excluding our own device and
 * dropping entries the server would reject (non-zero device with no key index).
 */
export declare const extractDeviceJids: (results: USyncDeviceResult[], myJid: string, myLid: string, excludeZeroDevices: boolean) => FullJid[];
/** Convert a FullJid device descriptor back into a JID string. */
export declare const deviceJid: (j: FullJid) => string;
export { jidNormalizedUser };
/** A USync protocol: the query node plus how to build/parse per-user data. */
export interface USyncProtocol {
    name: string;
    query: BinaryNode;
    user?: (u: USyncUserInput) => BinaryNode | null;
    parse?: (node: BinaryNode) => unknown;
}
export interface USyncUserInput {
    id?: string;
    phone?: string;
    lid?: string;
    type?: string;
}
/** Build a generic `<iq xmlns="usync">` for the given protocols and users. */
export declare const buildUSyncQuery: (protocols: USyncProtocol[], users: USyncUserInput[], context: string, mode: string, sid: string) => BinaryNode;
/** Parse a USync result into one record per user, keyed by protocol name. */
export declare const parseUSyncResult: (result: BinaryNode | undefined, protocols: USyncProtocol[]) => Record<string, unknown>[];
//# sourceMappingURL=index.d.ts.map