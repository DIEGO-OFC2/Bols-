import { randomBytes } from 'node:crypto';
/** Big-endian integer, default 4 bytes (matching the reference). */
export const encodeBigEndian = (value, bytes = 4) => {
    const out = new Uint8Array(bytes);
    let v = value;
    for (let i = bytes - 1; i >= 0; i--) {
        out[i] = v & 0xff;
        v >>>= 8;
    }
    return out;
};
/** 14-bit registration id. */
export const generateRegistrationId = () => Uint16Array.from(randomBytes(2))[0] & 16383;
export const randomBase64 = (bytes) => randomBytes(bytes).toString('base64');
export const unixTimestampSeconds = (date = new Date()) => Math.floor(date.getTime() / 1000);
export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export const toNumber = (value) => {
    if (value === null || value === undefined)
        return 0;
    if (typeof value === 'number')
        return value;
    if (typeof value === 'bigint')
        return Number(value);
    if (typeof value === 'object' && value && 'toNumber' in value) {
        return value.toNumber();
    }
    return 0;
};
export const bytesToCrockford = (buffer) => {
    // Crockford base32 alphabet, used for pairing codes.
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        output += alphabet[(value << (5 - bits)) & 31];
    return output;
};
//# sourceMappingURL=generics.js.map