/**
 * USync: the device-list query used before sending. For each recipient user we
 * ask the server which devices exist and which LID it maps to, so we know how
 * many Signal sessions to create and which addresses to encrypt to.
 */
import { S_WHATSAPP_NET, WAJIDDomains, jidDecode, jidNormalizedUser } from '../wabinary/jid.js';
import { getBinaryNodeChild, getBinaryNodeChildren } from '../wabinary/generic-utils.js';
/** Build the `<iq xmlns="usync">` node requesting device lists for `jids`. */
export const buildUSyncDeviceQuery = (jids, sid) => ({
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
});
/** Parse the device + lid information from a USync result. */
export const parseUSyncDeviceResult = (result) => {
    const usync = getBinaryNodeChild(result, 'usync');
    const list = getBinaryNodeChild(usync, 'list');
    if (!list)
        return [];
    const out = [];
    for (const user of getBinaryNodeChildren(list, 'user')) {
        const id = user.attrs.jid;
        if (!id)
            continue;
        const devicesNode = getBinaryNodeChild(user, 'devices');
        const lidNode = getBinaryNodeChild(user, 'lid');
        const devices = [];
        const deviceList = getBinaryNodeChild(devicesNode, 'device-list');
        for (const d of getBinaryNodeChildren(deviceList, 'device')) {
            devices.push({
                id: +d.attrs.id,
                keyIndex: d.attrs['key-index'] ? +d.attrs['key-index'] : undefined,
                isHosted: d.attrs['is_hosted'] === 'true'
            });
        }
        out.push({ id, lid: lidNode?.attrs.val, devices });
    }
    return out;
};
/**
 * Expand USync results into concrete device JIDs, excluding our own device and
 * dropping entries the server would reject (non-zero device with no key index).
 */
export const extractDeviceJids = (results, myJid, myLid, excludeZeroDevices) => {
    const my = jidDecode(myJid);
    const myLidUser = jidDecode(myLid)?.user;
    const out = [];
    for (const userResult of results) {
        const decoded = jidDecode(userResult.id);
        let { user, server, domainType } = decoded;
        for (const { id: device, keyIndex, isHosted } of userResult.devices) {
            if (excludeZeroDevices && device === 0)
                continue;
            if ((my.user === user || myLidUser === user) && my.device === device)
                continue;
            if (device !== 0 && keyIndex === undefined)
                continue;
            if (isHosted) {
                domainType = domainType === WAJIDDomains.LID ? WAJIDDomains.HOSTED_LID : WAJIDDomains.HOSTED;
            }
            out.push({ user, server, domainType, device });
        }
    }
    return out;
};
/** Convert a FullJid device descriptor back into a JID string. */
export const deviceJid = (j) => {
    const server = j.server === 'c.us' ? 's.whatsapp.net' : j.server;
    const user = j.domainType && j.domainType !== WAJIDDomains.WHATSAPP ? `${j.user}_${j.domainType}` : j.user;
    return `${user}:${j.device ?? 0}@${server}`;
};
export { jidNormalizedUser };
/** Build a generic `<iq xmlns="usync">` for the given protocols and users. */
export const buildUSyncQuery = (protocols, users, context, mode, sid) => ({
    tag: 'iq',
    attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' },
    content: [
        {
            tag: 'usync',
            attrs: { context, mode, sid, last: 'true', index: '0' },
            content: [
                { tag: 'query', attrs: {}, content: protocols.map(p => p.query) },
                {
                    tag: 'list',
                    attrs: {},
                    content: users.map(u => ({
                        tag: 'user',
                        attrs: u.phone ? {} : { jid: u.id ?? '' },
                        content: protocols.map(p => p.user?.(u)).filter((n) => !!n)
                    }))
                }
            ]
        }
    ]
});
/** Parse a USync result into one record per user, keyed by protocol name. */
export const parseUSyncResult = (result, protocols) => {
    const usync = getBinaryNodeChild(result, 'usync');
    const list = getBinaryNodeChild(usync, 'list');
    if (!list)
        return [];
    const out = [];
    for (const user of getBinaryNodeChildren(list, 'user')) {
        const id = user.attrs.jid;
        if (!id)
            continue;
        const entry = { id };
        for (const p of protocols) {
            const node = getBinaryNodeChild(user, p.name);
            if (node)
                entry[p.name] = p.parse ? p.parse(node) : node;
        }
        out.push(entry);
    }
    return out;
};
//# sourceMappingURL=index.js.map