export declare enum PlatformType {
    UNKNOWN = 0,
    CHROME = 1,
    FIREFOX = 2,
    IE = 3,
    OPERA = 4,
    SAFARI = 5,
    EDGE = 6,
    DESKTOP = 7,
    IPAD = 8,
    ANDROID_TABLET = 9,
    OHANA = 10,
    ALOHA = 11,
    CATALINA = 12,
    TCL_TV = 13,
    IOS_PHONE = 14,
    IOS_CATALYST = 15,
    ANDROID_PHONE = 16,
    ANDROID_AMBIGUOUS = 17,
    WEAR_OS = 18,
    AR_WRIST = 19,
    AR_DEVICE = 20,
    UWP = 21,
    UBUNTU = 22,
    WEB = 23
}
export declare enum ConnectType {
    CELLULAR_UNKNOWN = 0,
    WIFI_UNKNOWN = 1
}
export declare enum ConnectReason {
    PUSH = 0,
    USER_ACTIVATED = 1,
    SCHEDULED = 2,
    ERROR_RECONNECT = 3,
    NETWORK_SWITCH = 4,
    PING_RECONNECT = 5,
    UNKNOWN = 6
}
export declare enum Product {
    WHATSAPP = 0,
    MESSENGER = 1,
    INTEROP = 2,
    INTEROP_MSGR = 3,
    WHATSAPP_LID = 4
}
export interface AppVersion {
    primary?: number;
    secondary?: number;
    tertiary?: number;
    quaternary?: number;
    quinary?: number;
}
export interface DeviceProps {
    os?: string;
    version?: AppVersion;
    platformType?: PlatformType;
    requireFullSync?: boolean;
    historySyncConfig?: HistorySyncConfig;
}
export interface HistorySyncConfig {
    fullSyncDaysLimit?: number;
    fullSyncSizeMbLimit?: number;
    storageQuotaMb?: number;
    inlineInitialPayloadInE2EeMsg?: boolean;
    recentSyncDaysLimit?: number;
    supportCallLogHistory?: boolean;
    supportBotUserAgentChatHistory?: boolean;
    supportCagReactionsAndPolls?: boolean;
    supportBizHostedMsg?: boolean;
    supportRecentSyncChunkMessageCountTuning?: boolean;
    supportHostedGroupMsg?: boolean;
    supportFbidBotChatHistory?: boolean;
    supportAddOnHistorySyncMigration?: boolean;
    supportMessageAssociation?: boolean;
    supportGroupHistory?: boolean;
    onDemandReady?: boolean;
    supportGuestChat?: boolean;
    completeOnDemandReady?: boolean;
    thumbnailSyncDaysLimit?: number;
}
export interface ClientPayload {
    username?: bigint;
    passive?: boolean;
    userAgent?: {
        platform?: number;
        appVersion?: AppVersion;
        mcc?: string;
        mnc?: string;
        osVersion?: string;
        manufacturer?: string;
        device?: string;
        osBuildNumber?: string;
        phoneId?: string;
        releaseChannel?: number;
        localeLanguageIso6391?: string;
        localeCountryIso31661Alpha2?: string;
        deviceBoard?: string;
        deviceExpId?: string;
        deviceType?: number;
        deviceModelType?: string;
    };
    webInfo?: {
        refToken?: string;
        version?: string;
        webdPayload?: {
            usesParticipantInKey?: boolean;
            supportsStarredMessages?: boolean;
            supportsDocumentMessages?: boolean;
            supportsUrlMessages?: boolean;
            supportsMediaRetry?: boolean;
            supportsE2EImage?: boolean;
            supportsE2EVideo?: boolean;
            supportsE2EAudio?: boolean;
            supportsE2EDocument?: boolean;
            documentTypes?: string;
            features?: Uint8Array;
        };
        webSubPlatform?: number;
    };
    pushName?: string;
    sessionId?: number;
    shortConnect?: boolean;
    connectType?: ConnectType;
    connectReason?: ConnectReason;
    shards?: number[];
    dnsSource?: {
        dnsMethod?: number;
        appCached?: boolean;
    };
    connectAttemptCount?: number;
    device?: number;
    devicePairingData?: {
        eRegid?: Uint8Array;
        eKeytype?: Uint8Array;
        eIdent?: Uint8Array;
        eSkeyId?: Uint8Array;
        eSkeyVal?: Uint8Array;
        eSkeySig?: Uint8Array;
        buildHash?: Uint8Array;
        deviceProps?: Uint8Array;
    };
    product?: Product;
    fbCat?: Uint8Array;
    fbUserAgent?: Uint8Array;
    oc?: boolean;
    lc?: number;
    iosAppExtension?: number;
    fbAppId?: bigint;
    fbDeviceId?: Uint8Array;
    pull?: boolean;
    paddingBytes?: Uint8Array;
    yearClass?: number;
    memClass?: number;
    lidDbMigrated?: boolean;
    accountType?: number;
    connectionSequenceInfo?: number;
    paaLink?: boolean;
    preacksCount?: number;
    processingQueueSize?: number;
}
export declare const encodeDeviceProps: (props: DeviceProps) => Buffer;
export declare const decodeDeviceProps: (buf: Uint8Array) => DeviceProps;
export declare const encodeClientPayload: (p: ClientPayload) => Buffer;
export declare const decodeClientPayload: (buf: Uint8Array) => ClientPayload;
//# sourceMappingURL=client-payload.d.ts.map