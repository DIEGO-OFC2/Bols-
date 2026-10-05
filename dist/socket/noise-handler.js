import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, sha256 } from '../crypto/index.js';
import { decodeBinaryNodeFrame } from '../wabinary/decode.js';
import { decodeCertChain, decodeNoiseCertificateDetails } from '../proto/cert-chain.js';
export const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0';
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, 3]);
export const WA_CERT_SERIAL = 0;
export const WA_CERT_PUBLIC_KEY = Buffer.from('142375574d0a587166aae71ebe516437c4a28b73e3695c6ce1f7f9545da8ee6b', 'hex');
const IV_LENGTH = 12;
const EMPTY = Buffer.alloc(0);
// Upper bound for a single decrypted frame; protects against a hostile length prefix.
const MAX_FRAME_SIZE = 16 * 1024 * 1024;
/**
 * AES-GCM transport with a monotonic 32-bit counter IV (last four bytes).
 * Keys are fixed once the handshake completes.
 */
class TransportState {
    encKey;
    decKey;
    readCounter = 0;
    writeCounter = 0;
    readIv = Buffer.alloc(IV_LENGTH);
    writeIv = Buffer.alloc(IV_LENGTH);
    constructor(encKey, decKey) {
        this.encKey = encKey;
        this.decKey = decKey;
    }
    static stamp(iv, counter) {
        iv.writeUInt32BE(counter >>> 0, 8);
        return iv;
    }
    encrypt(plaintext) {
        return aesEncryptGCM(plaintext, this.encKey, TransportState.stamp(this.writeIv, this.writeCounter++), EMPTY);
    }
    decrypt(ciphertext) {
        return aesDecryptGCM(ciphertext, this.decKey, TransportState.stamp(this.readIv, this.readCounter++), EMPTY);
    }
}
export class NoiseHandler {
    opts;
    hash;
    salt;
    encKey;
    decKey;
    counter = 0;
    sentIntro = false;
    transport = null;
    isWaitingForTransport = false;
    pendingSink = null;
    inBytes = Buffer.alloc(0);
    introHeader;
    constructor(opts) {
        this.opts = opts;
        const data = Buffer.from(NOISE_MODE);
        this.hash = data.length === 32 ? data : sha256(data);
        this.salt = this.hash;
        this.encKey = this.hash;
        this.decKey = this.hash;
        if (opts.routingInfo?.length) {
            const routingInfo = opts.routingInfo;
            this.introHeader = Buffer.alloc(7 + routingInfo.length + NOISE_WA_HEADER.length);
            this.introHeader.write('ED', 0, 'utf8');
            this.introHeader.writeUInt8(0, 2);
            this.introHeader.writeUInt8(1, 3);
            this.introHeader.writeUInt8((routingInfo.length >> 16) & 0xff, 4);
            this.introHeader.writeUInt16BE(routingInfo.length & 0xffff, 5);
            this.introHeader.set(routingInfo, 7);
            this.introHeader.set(NOISE_WA_HEADER, 7 + routingInfo.length);
        }
        else {
            this.introHeader = Buffer.from(NOISE_WA_HEADER);
        }
        this.authenticate(NOISE_WA_HEADER);
        this.authenticate(opts.keyPair.public);
    }
    authenticate(data) {
        if (!this.transport)
            this.hash = sha256(Buffer.concat([Buffer.from(this.hash), Buffer.from(data)]));
    }
    static iv(counter) {
        const iv = Buffer.alloc(IV_LENGTH);
        iv.writeUInt32BE(counter >>> 0, 8);
        return iv;
    }
    encrypt(plaintext) {
        if (this.transport)
            return this.transport.encrypt(plaintext);
        const result = aesEncryptGCM(plaintext, this.encKey, NoiseHandler.iv(this.counter++), this.hash);
        this.authenticate(result);
        return result;
    }
    decrypt(ciphertext) {
        if (this.transport)
            return this.transport.decrypt(ciphertext);
        const result = aesDecryptGCM(ciphertext, this.decKey, NoiseHandler.iv(this.counter++), this.hash);
        this.authenticate(ciphertext);
        return result;
    }
    localHKDF(data) {
        const key = hkdf(data, 64, { salt: this.salt, info: '' });
        return [key.subarray(0, 32), key.subarray(32)];
    }
    mixIntoKey(data) {
        const [write, read] = this.localHKDF(data);
        this.salt = write;
        this.encKey = read;
        this.decKey = read;
        this.counter = 0;
    }
    /** Reset both transport counters, keeping keys (used when the server restarts its IVs). */
    resetTransportCounters() {
        if (this.transport)
            this.transport = new TransportState(this.encKey, this.decKey);
    }
    /** Derive the transport keys; any buffered frames are flushed to `sink`. */
    async finishInit(sink) {
        this.isWaitingForTransport = true;
        const [write, read] = this.localHKDF(EMPTY);
        this.transport = new TransportState(write, read);
        this.isWaitingForTransport = false;
        const pending = sink ?? this.pendingSink;
        if (pending && this.inBytes.length) {
            this.opts.logger?.trace({ length: this.inBytes.length }, 'flushing buffered frames');
            await this.processData(pending);
        }
        this.pendingSink = null;
    }
    /** Validate the server certificate chain (XEdDSA signatures over the leaf). */
    verifyCertificate(handshake) {
        const certDecoded = this.decrypt(handshake.serverHello.payload);
        const { intermediate, leaf } = decodeCertChain(certDecoded);
        if (!leaf?.details || !leaf.signature)
            throw new Error('invalid noise leaf certificate');
        if (!intermediate?.details || !intermediate.signature)
            throw new Error('invalid noise intermediate certificate');
        const details = decodeNoiseCertificateDetails(intermediate.details);
        if (!details.key)
            throw new Error('invalid noise intermediate key');
        const certKey = this.opts.certPublicKey ?? WA_CERT_PUBLIC_KEY;
        const certSerial = this.opts.certSerial ?? WA_CERT_SERIAL;
        const leafOk = Curve.verify(details.key, leaf.details, leaf.signature);
        const intermediateOk = Curve.verify(certKey, intermediate.details, intermediate.signature);
        if (!leafOk)
            throw new Error('noise certificate signature invalid');
        if (!intermediateOk)
            throw new Error('noise intermediate certificate signature invalid');
        if (details.issuerSerial !== certSerial)
            throw new Error('certification match failed');
    }
    /**
     * Process the server hello: mix keys and return the client static-key
     * ciphertext for the client finish message.
     */
    processHandshake(handshake, noiseKey) {
        const serverHello = handshake.serverHello;
        this.authenticate(serverHello.ephemeral);
        // Client ephemeral <-> server ephemeral.
        this.mixIntoKey(Curve.sharedKey(this.opts.keyPair.private, serverHello.ephemeral));
        const decStaticContent = this.decrypt(serverHello.static);
        // Client ephemeral <-> server static.
        this.mixIntoKey(Curve.sharedKey(this.opts.keyPair.private, decStaticContent));
        this.verifyCertificate(handshake);
        const keyEnc = this.encrypt(noiseKey.public);
        // Client static (noise key) <-> server ephemeral.
        this.mixIntoKey(Curve.sharedKey(noiseKey.private, serverHello.ephemeral));
        return Buffer.from(keyEnc);
    }
    /** Prefix the frame with the intro header (once) and a 3-byte length. */
    encodeFrame(data) {
        const payload = this.transport ? this.transport.encrypt(data) : data;
        const introSize = this.sentIntro ? 0 : this.introHeader.length;
        const frame = Buffer.allocUnsafe(introSize + 3 + payload.length);
        if (!this.sentIntro) {
            frame.set(this.introHeader, 0);
            this.sentIntro = true;
        }
        frame.writeUIntBE(payload.length, introSize, 3);
        frame.set(payload, introSize + 3);
        return frame;
    }
    async decodeFrame(newData, onFrame) {
        if (this.isWaitingForTransport) {
            const merged = Buffer.allocUnsafe(this.inBytes.length + newData.length);
            this.inBytes.copy(merged, 0);
            merged.set(newData, this.inBytes.length);
            this.inBytes = merged;
            this.pendingSink = onFrame;
            return;
        }
        this.inBytes = this.inBytes.length === 0 ? Buffer.from(newData) : Buffer.concat([this.inBytes, newData]);
        await this.processData(onFrame);
    }
    async processData(onFrame) {
        while (this.inBytes.length >= 3) {
            const size = this.inBytes.readUIntBE(0, 3);
            if (size > MAX_FRAME_SIZE)
                throw new Error(`frame size ${size} exceeds limit`);
            if (this.inBytes.length < size + 3)
                return;
            let frame = this.inBytes.subarray(3, size + 3);
            // subarray keeps a reference to the backing buffer; advance past the slice.
            this.inBytes = this.inBytes.subarray(size + 3);
            if (this.transport) {
                frame = await decodeBinaryNodeFrame(this.transport.decrypt(frame));
            }
            onFrame(frame);
        }
        // Release the backing buffer once fully consumed.
        if (this.inBytes.length === 0)
            this.inBytes = Buffer.alloc(0);
    }
}
//# sourceMappingURL=noise-handler.js.map