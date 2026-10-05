export interface NoiseCertificateDetails {
    serial?: number;
    issuerSerial?: number;
    key?: Buffer;
    notBefore?: bigint;
    notAfter?: bigint;
}
export interface NoiseCertificate {
    details?: Buffer;
    signature?: Buffer;
}
export interface CertChain {
    leaf?: NoiseCertificate;
    intermediate?: NoiseCertificate;
}
export declare const decodeNoiseCertificate: (buf: Buffer) => NoiseCertificate;
export declare const decodeCertChain: (buf: Uint8Array) => CertChain;
export declare const decodeNoiseCertificateDetails: (buf: Buffer) => NoiseCertificateDetails;
export declare const encodeNoiseCertificate: (cert: NoiseCertificate) => Buffer;
export declare const encodeNoiseCertificateDetails: (d: NoiseCertificateDetails) => Buffer;
export declare const encodeCertChain: (chain: CertChain) => Buffer;
//# sourceMappingURL=cert-chain.d.ts.map