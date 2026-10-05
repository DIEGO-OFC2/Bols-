/** The in-memory representation of a WhatsApp binary node ("stanza"). */
export interface BinaryNode {
    tag: string;
    attrs: Record<string, string>;
    content?: BinaryNode[] | string | Uint8Array;
}
export declare const TAGS: {
    readonly LIST_EMPTY: 0;
    readonly DICTIONARY_0: 236;
    readonly DICTIONARY_1: 237;
    readonly DICTIONARY_2: 238;
    readonly DICTIONARY_3: 239;
    readonly INTEROP_JID: 245;
    readonly FB_JID: 246;
    readonly AD_JID: 247;
    readonly LIST_8: 248;
    readonly LIST_16: 249;
    readonly JID_PAIR: 250;
    readonly HEX_8: 251;
    readonly BINARY_8: 252;
    readonly BINARY_20: 253;
    readonly BINARY_32: 254;
    readonly NIBBLE_8: 255;
    readonly PACKED_MAX: 127;
};
export declare const WAJIDDomains: {
    readonly WHATSAPP: 0;
    readonly LID: 1;
    readonly HOSTED: 128;
    readonly HOSTED_LID: 129;
};
export interface FullJid {
    user: string;
    server: string;
    device?: number;
    agent?: number;
    domainType?: number;
}
//# sourceMappingURL=types.d.ts.map