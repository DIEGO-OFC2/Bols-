import { TOKEN_MAP } from './tokens.js';
import { jidDecode } from './jid.js';
import { TAGS } from './types.js';
/**
 * A small growable byte sink. Writing straight into one contiguous buffer
 * avoids the per-byte `Array.push` cost and the final `Buffer.from(number[])`
 * copy that a naive encoder pays.
 */
class ByteWriter {
    buf;
    len = 0;
    constructor(initial = 256) {
        this.buf = Buffer.allocUnsafe(initial);
    }
    ensure(extra) {
        const needed = this.len + extra;
        if (needed <= this.buf.length)
            return;
        let size = this.buf.length * 2;
        while (size < needed)
            size *= 2;
        const next = Buffer.allocUnsafe(size);
        this.buf.copy(next, 0, 0, this.len);
        this.buf = next;
    }
    byte(v) {
        this.ensure(1);
        this.buf[this.len++] = v & 0xff;
    }
    bytes(src) {
        this.ensure(src.length);
        this.buf.set(src, this.len);
        this.len += src.length;
    }
    /** big-endian fixed-width integer (n bytes) */
    intBE(value, n) {
        this.ensure(n);
        for (let i = 0; i < n; i++) {
            this.buf[this.len + i] = (value >>> ((n - 1 - i) * 8)) & 0xff;
        }
        this.len += n;
    }
    /** UTF-8 string */
    str(s) {
        const n = Buffer.byteLength(s);
        this.ensure(n);
        this.buf.write(s, this.len, n, 'utf8');
        this.len += n;
    }
    finish() {
        return this.buf.subarray(0, this.len);
    }
}
const CROCKFORD = '123456789ABCDEFGHJKLMNPQRSTVWXYZ';
const isNibble = (s) => {
    if (!s || s.length > TAGS.PACKED_MAX)
        return false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        const ok = (c >= 48 && c <= 57) || c === 45 /* - */ || c === 46; /* . */
        if (!ok)
            return false;
    }
    return true;
};
const isHex = (s) => {
    if (!s || s.length > TAGS.PACKED_MAX)
        return false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        // Only uppercase A-F qualifies, matching WhatsApp Web's encoder.
        const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 70);
        if (!ok)
            return false;
    }
    return true;
};
const packNibble = (code) => {
    if (code >= 48 && code <= 57)
        return code - 48;
    if (code === 45)
        return 10;
    if (code === 46)
        return 11;
    if (code === 0)
        return 15;
    throw new Error(`invalid nibble char: ${code}`);
};
const packHex = (code) => {
    if (code >= 48 && code <= 57)
        return code - 48;
    if (code >= 65 && code <= 70)
        return 10 + code - 65;
    if (code >= 97 && code <= 102)
        return 10 + code - 97;
    if (code === 0)
        return 15;
    throw new Error(`invalid hex char: ${code}`);
};
const writeByteLength = (w, length) => {
    if (length >= 1 << 20) {
        w.byte(TAGS.BINARY_32);
        w.intBE(length, 4);
    }
    else if (length >= 256) {
        w.byte(TAGS.BINARY_20);
        w.byte((length >> 16) & 0x0f);
        w.intBE(length & 0xffff, 2);
    }
    else {
        w.byte(TAGS.BINARY_8);
        w.byte(length);
    }
};
const writeStringRaw = (w, s) => {
    const n = Buffer.byteLength(s);
    writeByteLength(w, n);
    w.str(s);
};
const writePacked = (w, s, hex) => {
    w.byte(hex ? TAGS.HEX_8 : TAGS.NIBBLE_8);
    let rounded = (s.length + 1) >> 1;
    if (s.length % 2 !== 0)
        rounded |= 128;
    w.byte(rounded);
    const pack = hex ? packHex : packNibble;
    const chars = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++)
        chars[i] = pack(s.charCodeAt(i));
    if (s.length % 2 !== 0)
        chars[s.length] = 15;
    const pairCount = rounded & 127;
    for (let i = 0; i < pairCount; i++) {
        w.byte((chars[2 * i] << 4) | chars[2 * i + 1]);
    }
};
const writeJid = (w, jid) => {
    const decoded = jidDecode(jid);
    if (!decoded)
        return false;
    const { user, server, device, agent, domainType } = decoded;
    if (device !== undefined) {
        w.byte(TAGS.AD_JID);
        w.byte(domainType || 0);
        w.byte(device);
        writeString(w, user);
    }
    else {
        w.byte(TAGS.JID_PAIR);
        if (user.length)
            writeString(w, user);
        else
            w.byte(TAGS.LIST_EMPTY);
        writeString(w, server);
    }
    void agent;
    return true;
};
const writeString = (w, s) => {
    if (s === undefined || s === null) {
        w.byte(TAGS.LIST_EMPTY);
        return;
    }
    if (s === '') {
        writeStringRaw(w, s);
        return;
    }
    const token = TOKEN_MAP[s];
    if (token) {
        if (token.dict !== undefined)
            w.byte(TAGS.DICTIONARY_0 + token.dict);
        w.byte(token.index);
        return;
    }
    if (isNibble(s)) {
        writePacked(w, s, false);
    }
    else if (isHex(s)) {
        writePacked(w, s, true);
    }
    else if (s.indexOf('@') >= 0 && writeJid(w, s)) {
        // encoded as a JID
    }
    else {
        writeStringRaw(w, s);
    }
};
const writeListStart = (w, size) => {
    if (size === 0) {
        w.byte(TAGS.LIST_EMPTY);
    }
    else if (size < 256) {
        w.byte(TAGS.LIST_8);
        w.byte(size);
    }
    else {
        w.byte(TAGS.LIST_16);
        w.intBE(size, 2);
    }
};
const encodeInner = (w, node) => {
    const { tag, attrs, content } = node;
    if (!tag)
        throw new Error('Invalid node: tag cannot be undefined');
    const attrKeys = attrs ? Object.keys(attrs) : [];
    let validAttrCount = 0;
    for (const k of attrKeys) {
        const v = attrs[k];
        if (v !== undefined && v !== null)
            validAttrCount++;
    }
    writeListStart(w, validAttrCount * 2 + 1 + (content !== undefined ? 1 : 0));
    writeString(w, tag);
    for (const k of attrKeys) {
        const v = attrs[k];
        if (v === undefined || v === null)
            continue;
        writeString(w, k);
        writeString(w, v);
    }
    if (typeof content === 'string') {
        writeString(w, content);
    }
    else if (content instanceof Uint8Array) {
        writeByteLength(w, content.length);
        w.bytes(content);
    }
    else if (Array.isArray(content)) {
        const children = content.filter(c => c && (c.tag || c instanceof Uint8Array || typeof c === 'string'));
        writeListStart(w, children.length);
        for (const child of children) {
            if (typeof child === 'string')
                writeString(w, child);
            else if (child instanceof Uint8Array) {
                writeByteLength(w, child.length);
                w.bytes(child);
            }
            else
                encodeInner(w, child);
        }
    }
    else if (content === undefined) {
        // no content
    }
    else {
        throw new Error(`invalid children for header "${tag}"`);
    }
};
export const encodeBinaryNode = (node) => {
    const w = new ByteWriter();
    w.byte(0); // dictionary version / compression flag prefix
    encodeInner(w, node);
    return w.finish();
};
/** Encode a node straight into a caller-owned writer (used inside the frame writer). */
export const encodeBinaryNodeTo = (w, node) => encodeInner(w, node);
export { ByteWriter, writeByteLength, writeString, writeListStart, encodeInner };
export { CROCKFORD };
//# sourceMappingURL=encode.js.map