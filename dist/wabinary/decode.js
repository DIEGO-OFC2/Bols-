import { inflate } from 'node:zlib';
import { promisify } from 'node:util';
import { DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS } from './tokens.js';
import { jidEncode } from './jid.js';
import { TAGS, WAJIDDomains } from './types.js';
const inflateAsync = promisify(inflate);
/**
 * If the frame starts with the compression flag, inflate the remainder.
 * Otherwise drop the leading dictionary-version byte.
 */
export const maybeDecompress = async (frame) => {
    if (frame.length === 0)
        throw new Error('empty frame');
    if (frame[0] & 2) {
        return (await inflateAsync(frame.subarray(1)));
    }
    return frame.subarray(1);
};
class BinaryReader {
    buf;
    // The first byte is the dictionary-version / compression flag; callers
    // decompress and strip it before reading (see `maybeDecompress`).
    index = 0;
    constructor(buf) {
        this.buf = buf;
    }
    need(n) {
        if (this.index + n > this.buf.length)
            throw new Error('end of stream');
    }
    byte() {
        this.need(1);
        return this.buf[this.index++];
    }
    bytes(n) {
        this.need(n);
        const out = this.buf.subarray(this.index, this.index + n);
        this.index += n;
        return out;
    }
    intBE(n) {
        this.need(n);
        let v = 0;
        for (let i = 0; i < n; i++)
            v = v * 256 + this.buf[this.index + i];
        this.index += n;
        return v;
    }
    int20() {
        this.need(3);
        const v = ((this.buf[this.index] & 15) << 16) + (this.buf[this.index + 1] << 8) + this.buf[this.index + 2];
        this.index += 3;
        return v;
    }
    listSize(tag) {
        switch (tag) {
            case TAGS.LIST_EMPTY:
                return 0;
            case TAGS.LIST_8:
                return this.byte();
            case TAGS.LIST_16:
                return this.intBE(2);
            default:
                throw new Error(`invalid list tag: ${tag}`);
        }
    }
    packed(tag) {
        const start = this.byte();
        const count = start & 127;
        const out = Buffer.allocUnsafe(count * 2 + 1);
        let len = 0;
        const hex = tag === TAGS.HEX_8;
        for (let i = 0; i < count; i++) {
            const b = this.byte();
            out[len++] = unpack(hex, (b & 0xf0) >> 4);
            out[len++] = unpack(hex, b & 0x0f);
        }
        if (start >> 7 !== 0)
            out[len - 1] = 0;
        const end = start >> 7 !== 0 ? len - 1 : len;
        return out.subarray(0, end).toString('utf8');
    }
    string(tag) {
        if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length)
            return SINGLE_BYTE_TOKENS[tag];
        switch (tag) {
            case TAGS.DICTIONARY_0:
            case TAGS.DICTIONARY_1:
            case TAGS.DICTIONARY_2:
            case TAGS.DICTIONARY_3: {
                const dict = DOUBLE_BYTE_TOKENS[tag - TAGS.DICTIONARY_0];
                const idx = this.byte();
                const token = dict?.[idx];
                if (token === undefined)
                    throw new Error(`invalid double token ${tag - TAGS.DICTIONARY_0}:${idx}`);
                return token;
            }
            case TAGS.LIST_EMPTY:
                return '';
            case TAGS.BINARY_8:
                return this.bytes(this.byte()).toString('utf8');
            case TAGS.BINARY_20:
                return this.bytes(this.int20()).toString('utf8');
            case TAGS.BINARY_32:
                return this.bytes(this.intBE(4)).toString('utf8');
            case TAGS.JID_PAIR: {
                const user = this.string(this.byte());
                const server = this.string(this.byte());
                if (!server)
                    throw new Error('invalid jid pair');
                return `${user}@${server}`;
            }
            case TAGS.FB_JID: {
                const user = this.string(this.byte());
                const device = this.intBE(2);
                const server = this.string(this.byte());
                return `${user}:${device}@${server}`;
            }
            case TAGS.INTEROP_JID: {
                const user = this.string(this.byte());
                const device = this.intBE(2);
                const integrator = this.intBE(2);
                let server = 'interop';
                const before = this.index;
                try {
                    server = this.string(this.byte());
                }
                catch {
                    this.index = before;
                }
                return `${integrator}-${user}:${device}@${server}`;
            }
            case TAGS.AD_JID: {
                const domainType = this.byte();
                const device = this.byte();
                const user = this.string(this.byte());
                let server = 's.whatsapp.net';
                if (domainType === WAJIDDomains.LID)
                    server = 'lid';
                else if (domainType === WAJIDDomains.HOSTED)
                    server = 'hosted';
                else if (domainType === WAJIDDomains.HOSTED_LID)
                    server = 'hosted.lid';
                return jidEncode(user, server, device);
            }
            case TAGS.HEX_8:
            case TAGS.NIBBLE_8:
                return this.packed(tag);
            default:
                throw new Error(`invalid string tag: ${tag}`);
        }
    }
    node() {
        const size = this.listSize(this.byte());
        const tag = this.string(this.byte());
        if (!size || !tag)
            throw new Error('invalid node');
        const attrs = {};
        const attrCount = (size - 1) >> 1;
        for (let i = 0; i < attrCount; i++) {
            attrs[this.string(this.byte())] = this.string(this.byte());
        }
        let content;
        if (size % 2 === 0) {
            const tagByte = this.byte();
            if (tagByte === TAGS.LIST_EMPTY || tagByte === TAGS.LIST_8 || tagByte === TAGS.LIST_16) {
                const n = this.listSize(tagByte);
                const items = new Array(n);
                for (let i = 0; i < n; i++)
                    items[i] = this.node();
                content = items;
            }
            else {
                switch (tagByte) {
                    case TAGS.BINARY_8:
                        content = this.bytes(this.byte());
                        break;
                    case TAGS.BINARY_20:
                        content = this.bytes(this.int20());
                        break;
                    case TAGS.BINARY_32:
                        content = this.bytes(this.intBE(4));
                        break;
                    default:
                        content = this.string(tagByte);
                }
            }
        }
        return { tag, attrs, content };
    }
}
const HEX = '0123456789ABCDEF';
const unpack = (hex, v) => {
    if (v < 10)
        return 48 + v;
    if (hex)
        return 65 + v - 10;
    if (v === 10)
        return 45; // '-'
    if (v === 11)
        return 46; // '.'
    if (v === 15)
        return 0;
    throw new Error(`invalid packed value: ${v}`);
};
void HEX;
/** Decode an uncompressed node, dropping the leading flag byte. */
export const decodeBinaryNode = (buffer) => new BinaryReader(buffer.subarray(1)).node();
/** Decode a frame, inflating it first when the compression flag is set. */
export const decodeBinaryNodeFrame = async (buffer) => new BinaryReader(await maybeDecompress(buffer)).node();
//# sourceMappingURL=decode.js.map