import { ProtoReader, ProtoWriter } from './writer.js';
const asString = (v) => Buffer.from(v).toString('utf-8');
export var PlatformType;
(function (PlatformType) {
    PlatformType[PlatformType["UNKNOWN"] = 0] = "UNKNOWN";
    PlatformType[PlatformType["CHROME"] = 1] = "CHROME";
    PlatformType[PlatformType["FIREFOX"] = 2] = "FIREFOX";
    PlatformType[PlatformType["IE"] = 3] = "IE";
    PlatformType[PlatformType["OPERA"] = 4] = "OPERA";
    PlatformType[PlatformType["SAFARI"] = 5] = "SAFARI";
    PlatformType[PlatformType["EDGE"] = 6] = "EDGE";
    PlatformType[PlatformType["DESKTOP"] = 7] = "DESKTOP";
    PlatformType[PlatformType["IPAD"] = 8] = "IPAD";
    PlatformType[PlatformType["ANDROID_TABLET"] = 9] = "ANDROID_TABLET";
    PlatformType[PlatformType["OHANA"] = 10] = "OHANA";
    PlatformType[PlatformType["ALOHA"] = 11] = "ALOHA";
    PlatformType[PlatformType["CATALINA"] = 12] = "CATALINA";
    PlatformType[PlatformType["TCL_TV"] = 13] = "TCL_TV";
    PlatformType[PlatformType["IOS_PHONE"] = 14] = "IOS_PHONE";
    PlatformType[PlatformType["IOS_CATALYST"] = 15] = "IOS_CATALYST";
    PlatformType[PlatformType["ANDROID_PHONE"] = 16] = "ANDROID_PHONE";
    PlatformType[PlatformType["ANDROID_AMBIGUOUS"] = 17] = "ANDROID_AMBIGUOUS";
    PlatformType[PlatformType["WEAR_OS"] = 18] = "WEAR_OS";
    PlatformType[PlatformType["AR_WRIST"] = 19] = "AR_WRIST";
    PlatformType[PlatformType["AR_DEVICE"] = 20] = "AR_DEVICE";
    PlatformType[PlatformType["UWP"] = 21] = "UWP";
    PlatformType[PlatformType["UBUNTU"] = 22] = "UBUNTU";
    PlatformType[PlatformType["WEB"] = 23] = "WEB";
})(PlatformType || (PlatformType = {}));
export var ConnectType;
(function (ConnectType) {
    ConnectType[ConnectType["CELLULAR_UNKNOWN"] = 0] = "CELLULAR_UNKNOWN";
    ConnectType[ConnectType["WIFI_UNKNOWN"] = 1] = "WIFI_UNKNOWN";
})(ConnectType || (ConnectType = {}));
export var ConnectReason;
(function (ConnectReason) {
    ConnectReason[ConnectReason["PUSH"] = 0] = "PUSH";
    ConnectReason[ConnectReason["USER_ACTIVATED"] = 1] = "USER_ACTIVATED";
    ConnectReason[ConnectReason["SCHEDULED"] = 2] = "SCHEDULED";
    ConnectReason[ConnectReason["ERROR_RECONNECT"] = 3] = "ERROR_RECONNECT";
    ConnectReason[ConnectReason["NETWORK_SWITCH"] = 4] = "NETWORK_SWITCH";
    ConnectReason[ConnectReason["PING_RECONNECT"] = 5] = "PING_RECONNECT";
    ConnectReason[ConnectReason["UNKNOWN"] = 6] = "UNKNOWN";
})(ConnectReason || (ConnectReason = {}));
export var Product;
(function (Product) {
    Product[Product["WHATSAPP"] = 0] = "WHATSAPP";
    Product[Product["MESSENGER"] = 1] = "MESSENGER";
    Product[Product["INTEROP"] = 2] = "INTEROP";
    Product[Product["INTEROP_MSGR"] = 3] = "INTEROP_MSGR";
    Product[Product["WHATSAPP_LID"] = 4] = "WHATSAPP_LID";
})(Product || (Product = {}));
// ---------------------------------------------------------------------------
// DeviceProps
// ---------------------------------------------------------------------------
const encodeAppVersion = (w, field, v) => {
    const inner = new ProtoWriter();
    if (v.primary !== undefined)
        inner.uint32(1, v.primary);
    if (v.secondary !== undefined)
        inner.uint32(2, v.secondary);
    if (v.tertiary !== undefined)
        inner.uint32(3, v.tertiary);
    if (v.quaternary !== undefined)
        inner.uint32(4, v.quaternary);
    if (v.quinary !== undefined)
        inner.uint32(5, v.quinary);
    w.message(field, inner);
};
export const encodeDeviceProps = (props) => {
    const w = new ProtoWriter();
    if (props.os !== undefined)
        w.string(1, props.os);
    if (props.version)
        encodeAppVersion(w, 2, props.version);
    if (props.platformType !== undefined)
        w.uint32(3, props.platformType);
    if (props.requireFullSync !== undefined)
        w.bool(4, props.requireFullSync);
    if (props.historySyncConfig)
        w.message(5, encodeHistorySyncConfig(props.historySyncConfig));
    return w.finish();
};
const encodeHistorySyncConfig = (c) => {
    const w = new ProtoWriter();
    if (c.fullSyncDaysLimit !== undefined)
        w.uint32(1, c.fullSyncDaysLimit);
    if (c.fullSyncSizeMbLimit !== undefined)
        w.uint32(2, c.fullSyncSizeMbLimit);
    if (c.storageQuotaMb !== undefined)
        w.uint32(3, c.storageQuotaMb);
    if (c.inlineInitialPayloadInE2EeMsg !== undefined)
        w.bool(4, c.inlineInitialPayloadInE2EeMsg);
    if (c.recentSyncDaysLimit !== undefined)
        w.uint32(5, c.recentSyncDaysLimit);
    if (c.supportCallLogHistory !== undefined)
        w.bool(6, c.supportCallLogHistory);
    if (c.supportBotUserAgentChatHistory !== undefined)
        w.bool(7, c.supportBotUserAgentChatHistory);
    if (c.supportCagReactionsAndPolls !== undefined)
        w.bool(8, c.supportCagReactionsAndPolls);
    if (c.supportBizHostedMsg !== undefined)
        w.bool(9, c.supportBizHostedMsg);
    if (c.supportRecentSyncChunkMessageCountTuning !== undefined)
        w.bool(10, c.supportRecentSyncChunkMessageCountTuning);
    if (c.supportHostedGroupMsg !== undefined)
        w.bool(11, c.supportHostedGroupMsg);
    if (c.supportFbidBotChatHistory !== undefined)
        w.bool(12, c.supportFbidBotChatHistory);
    if (c.supportAddOnHistorySyncMigration !== undefined)
        w.bool(13, c.supportAddOnHistorySyncMigration);
    if (c.supportMessageAssociation !== undefined)
        w.bool(14, c.supportMessageAssociation);
    if (c.supportGroupHistory !== undefined)
        w.bool(15, c.supportGroupHistory);
    if (c.onDemandReady !== undefined)
        w.bool(16, c.onDemandReady);
    if (c.supportGuestChat !== undefined)
        w.bool(17, c.supportGuestChat);
    if (c.completeOnDemandReady !== undefined)
        w.bool(18, c.completeOnDemandReady);
    if (c.thumbnailSyncDaysLimit !== undefined)
        w.uint32(19, c.thumbnailSyncDaysLimit);
    return w;
};
export const decodeDeviceProps = (buf) => {
    const r = new ProtoReader(Buffer.from(buf));
    const out = {};
    let entry;
    while ((entry = r.next())) {
        const { field, value } = entry;
        if (field === 1)
            out.os = asString(value);
        else if (field === 2)
            out.version = decodeAppVersion(value);
        else if (field === 3)
            out.platformType = Number(value);
        else if (field === 4)
            out.requireFullSync = Number(value) !== 0;
    }
    return out;
};
const decodeAppVersion = (buf) => {
    const r = new ProtoReader(buf);
    const out = {};
    let e;
    while ((e = r.next())) {
        const { field, value } = e;
        if (field === 1)
            out.primary = Number(value);
        else if (field === 2)
            out.secondary = Number(value);
        else if (field === 3)
            out.tertiary = Number(value);
        else if (field === 4)
            out.quaternary = Number(value);
        else if (field === 5)
            out.quinary = Number(value);
    }
    return out;
};
// ---------------------------------------------------------------------------
// ClientPayload
// ---------------------------------------------------------------------------
export const encodeClientPayload = (p) => {
    const w = new ProtoWriter();
    if (p.username !== undefined)
        w.uint64(1, p.username);
    if (p.passive !== undefined)
        w.bool(3, p.passive);
    if (p.userAgent) {
        const ua = p.userAgent;
        const inner = new ProtoWriter();
        if (ua.platform !== undefined)
            inner.uint32(1, ua.platform);
        if (ua.appVersion)
            encodeAppVersion(inner, 2, ua.appVersion);
        if (ua.mcc !== undefined)
            inner.string(3, ua.mcc);
        if (ua.mnc !== undefined)
            inner.string(4, ua.mnc);
        if (ua.osVersion !== undefined)
            inner.string(5, ua.osVersion);
        if (ua.manufacturer !== undefined)
            inner.string(6, ua.manufacturer);
        if (ua.device !== undefined)
            inner.string(7, ua.device);
        if (ua.osBuildNumber !== undefined)
            inner.string(8, ua.osBuildNumber);
        if (ua.phoneId !== undefined)
            inner.string(9, ua.phoneId);
        if (ua.releaseChannel !== undefined)
            inner.uint32(10, ua.releaseChannel);
        if (ua.localeLanguageIso6391 !== undefined)
            inner.string(11, ua.localeLanguageIso6391);
        if (ua.localeCountryIso31661Alpha2 !== undefined)
            inner.string(12, ua.localeCountryIso31661Alpha2);
        if (ua.deviceBoard !== undefined)
            inner.string(13, ua.deviceBoard);
        if (ua.deviceExpId !== undefined)
            inner.string(14, ua.deviceExpId);
        if (ua.deviceType !== undefined)
            inner.uint32(15, ua.deviceType);
        if (ua.deviceModelType !== undefined)
            inner.string(16, ua.deviceModelType);
        w.message(5, inner);
    }
    if (p.webInfo)
        encodeWebInfo(w, 6, p.webInfo);
    if (p.pushName !== undefined)
        w.string(7, p.pushName);
    if (p.sessionId !== undefined)
        w.sfixed32(9, p.sessionId);
    if (p.shortConnect !== undefined)
        w.bool(10, p.shortConnect);
    if (p.connectType !== undefined)
        w.uint32(12, p.connectType);
    if (p.connectReason !== undefined)
        w.uint32(13, p.connectReason);
    if (p.shards)
        w.repeatedInt32(14, p.shards);
    if (p.dnsSource) {
        const inner = new ProtoWriter();
        if (p.dnsSource.dnsMethod !== undefined)
            inner.uint32(15, p.dnsSource.dnsMethod);
        if (p.dnsSource.appCached !== undefined)
            inner.bool(16, p.dnsSource.appCached);
        w.message(15, inner);
    }
    if (p.connectAttemptCount !== undefined)
        w.uint32(16, p.connectAttemptCount);
    if (p.device !== undefined)
        w.uint32(18, p.device);
    if (p.devicePairingData) {
        const d = p.devicePairingData;
        const inner = new ProtoWriter();
        if (d.eRegid)
            inner.bytes(1, d.eRegid);
        if (d.eKeytype)
            inner.bytes(2, d.eKeytype);
        if (d.eIdent)
            inner.bytes(3, d.eIdent);
        if (d.eSkeyId)
            inner.bytes(4, d.eSkeyId);
        if (d.eSkeyVal)
            inner.bytes(5, d.eSkeyVal);
        if (d.eSkeySig)
            inner.bytes(6, d.eSkeySig);
        if (d.buildHash)
            inner.bytes(7, d.buildHash);
        if (d.deviceProps)
            inner.bytes(8, d.deviceProps);
        w.message(19, inner);
    }
    if (p.product !== undefined)
        w.uint32(20, p.product);
    if (p.fbCat)
        w.bytes(21, p.fbCat);
    if (p.fbUserAgent)
        w.bytes(22, p.fbUserAgent);
    if (p.oc !== undefined)
        w.bool(23, p.oc);
    if (p.lc !== undefined)
        w.int32(24, p.lc);
    if (p.iosAppExtension !== undefined)
        w.int32(30, p.iosAppExtension);
    if (p.fbAppId !== undefined)
        w.uint64(31, p.fbAppId);
    if (p.fbDeviceId)
        w.bytes(32, p.fbDeviceId);
    if (p.pull !== undefined)
        w.bool(33, p.pull);
    if (p.paddingBytes)
        w.bytes(34, p.paddingBytes);
    if (p.yearClass !== undefined)
        w.int32(36, p.yearClass);
    if (p.memClass !== undefined)
        w.int32(37, p.memClass);
    if (p.lidDbMigrated !== undefined)
        w.bool(41, p.lidDbMigrated);
    if (p.accountType !== undefined)
        w.uint32(42, p.accountType);
    if (p.connectionSequenceInfo !== undefined)
        w.sfixed32(43, p.connectionSequenceInfo);
    if (p.paaLink !== undefined)
        w.bool(44, p.paaLink);
    if (p.preacksCount !== undefined)
        w.int32(45, p.preacksCount);
    if (p.processingQueueSize !== undefined)
        w.int32(46, p.processingQueueSize);
    return w.finish();
};
const encodeWebInfo = (w, field, info) => {
    const inner = new ProtoWriter();
    if (info.refToken !== undefined)
        inner.string(1, info.refToken);
    if (info.version !== undefined)
        inner.string(2, info.version);
    if (info.webdPayload) {
        const p = info.webdPayload;
        const wp = new ProtoWriter();
        if (p.usesParticipantInKey !== undefined)
            wp.bool(1, p.usesParticipantInKey);
        if (p.supportsStarredMessages !== undefined)
            wp.bool(2, p.supportsStarredMessages);
        if (p.supportsDocumentMessages !== undefined)
            wp.bool(3, p.supportsDocumentMessages);
        if (p.supportsUrlMessages !== undefined)
            wp.bool(4, p.supportsUrlMessages);
        if (p.supportsMediaRetry !== undefined)
            wp.bool(5, p.supportsMediaRetry);
        if (p.supportsE2EImage !== undefined)
            wp.bool(6, p.supportsE2EImage);
        if (p.supportsE2EVideo !== undefined)
            wp.bool(7, p.supportsE2EVideo);
        if (p.supportsE2EAudio !== undefined)
            wp.bool(8, p.supportsE2EAudio);
        if (p.supportsE2EDocument !== undefined)
            wp.bool(9, p.supportsE2EDocument);
        if (p.documentTypes !== undefined)
            wp.string(10, p.documentTypes);
        if (p.features)
            wp.bytes(11, p.features);
        inner.message(3, wp);
    }
    if (info.webSubPlatform !== undefined)
        inner.uint32(4, info.webSubPlatform);
    w.message(field, inner);
};
export const decodeClientPayload = (buf) => {
    const r = new ProtoReader(Buffer.from(buf));
    const out = {};
    let e;
    while ((e = r.next())) {
        const { field, value } = e;
        switch (field) {
            case 1:
                out.username = value;
                break;
            case 3:
                out.passive = Number(value) !== 0;
                break;
            case 5:
                out.userAgent = decodeUserAgent(value);
                break;
            case 7:
                out.pushName = value.toString('utf-8');
                break;
            case 9:
                out.sessionId = value.readInt32LE(0);
                break;
            case 10:
                out.shortConnect = Number(value) !== 0;
                break;
            case 12:
                out.connectType = Number(value);
                break;
            case 13:
                out.connectReason = Number(value);
                break;
            case 14:
                out.shards = out.shards ?? [];
                out.shards.push(Number(value));
                break;
            case 16:
                out.connectAttemptCount = Number(value);
                break;
            case 18:
                out.device = Number(value);
                break;
            case 19:
                out.devicePairingData = decodeDevicePairingData(value);
                break;
            case 20:
                out.product = Number(value);
                break;
            case 23:
                out.oc = Number(value) !== 0;
                break;
            case 24:
                out.lc = Number(value);
                break;
            case 33:
                out.pull = Number(value) !== 0;
                break;
            case 36:
                out.yearClass = Number(value);
                break;
            case 37:
                out.memClass = Number(value);
                break;
            case 41:
                out.lidDbMigrated = Number(value) !== 0;
                break;
            case 42:
                out.accountType = Number(value);
                break;
            case 43:
                out.connectionSequenceInfo = value.readInt32LE(0);
                break;
            case 44:
                out.paaLink = Number(value) !== 0;
                break;
            case 45:
                out.preacksCount = Number(value);
                break;
            case 46:
                out.processingQueueSize = Number(value);
                break;
            default:
                break;
        }
    }
    return out;
};
const decodeDevicePairingData = (buf) => {
    const r = new ProtoReader(buf);
    const out = {};
    let e;
    while ((e = r.next())) {
        const { field, value } = e;
        switch (field) {
            case 1:
                out.eRegid = value;
                break;
            case 2:
                out.eKeytype = value;
                break;
            case 3:
                out.eIdent = value;
                break;
            case 4:
                out.eSkeyId = value;
                break;
            case 5:
                out.eSkeyVal = value;
                break;
            case 6:
                out.eSkeySig = value;
                break;
            case 7:
                out.buildHash = value;
                break;
            case 8:
                out.deviceProps = value;
                break;
            default:
                break;
        }
    }
    return out;
};
const decodeUserAgent = (buf) => {
    const r = new ProtoReader(buf);
    const out = {};
    let e;
    while ((e = r.next())) {
        const { field, value } = e;
        switch (field) {
            case 1:
                out.platform = Number(value);
                break;
            case 2:
                out.appVersion = decodeAppVersion(value);
                break;
            case 3:
                out.mcc = asString(value);
                break;
            case 4:
                out.mnc = asString(value);
                break;
            case 5:
                out.osVersion = asString(value);
                break;
            case 6:
                out.manufacturer = asString(value);
                break;
            case 7:
                out.device = asString(value);
                break;
            case 8:
                out.osBuildNumber = asString(value);
                break;
            case 9:
                out.phoneId = asString(value);
                break;
            case 10:
                out.releaseChannel = Number(value);
                break;
            case 11:
                out.localeLanguageIso6391 = asString(value);
                break;
            case 12:
                out.localeCountryIso31661Alpha2 = asString(value);
                break;
            case 13:
                out.deviceBoard = asString(value);
                break;
            case 14:
                out.deviceExpId = asString(value);
                break;
            case 15:
                out.deviceType = Number(value);
                break;
            case 16:
                out.deviceModelType = asString(value);
                break;
        }
    }
    return out;
};
//# sourceMappingURL=client-payload.js.map