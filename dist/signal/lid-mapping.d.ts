export declare class LIDMappingStore {
    private pnToLid;
    private lidToPn;
    storeLIDPNMappings(pairs: {
        lid: string;
        pn: string;
    }[]): Promise<void>;
    getLIDForPN(pn: string): Promise<string | undefined>;
    getPNForLID(lid: string): Promise<string | undefined>;
}
//# sourceMappingURL=lid-mapping.d.ts.map