export type BrowserDescription = [os: string, browser: string, version: string];
export declare const Browsers: {
    ubuntu: (browser: string) => BrowserDescription;
    macOS: (browser: string) => BrowserDescription;
    baileys: (browser: string) => BrowserDescription;
    windows: (browser: string) => BrowserDescription;
    /** A generic desktop browser used when no OS is specified. */
    desktop: (browser: string) => BrowserDescription;
};
//# sourceMappingURL=browser-utils.d.ts.map