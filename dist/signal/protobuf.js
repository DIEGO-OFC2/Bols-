/**
 * Protobuf codec for the Signal "WhisperText" wire messages, matching the
 * schema WhatsApp's libsignal uses. Hand-rolled to avoid a protobuf runtime.
 */
import { ProtoReader, ProtoWriter } from '../proto/writer.js';
export const encodeWhisperMessage = (msg) => new ProtoWriter()
    .bytes(1, msg.ephemeralKey)
    .uint32(2, msg.counter ?? 0)
    .uint32(3, msg.previousCounter ?? 0)
    .bytes(4, msg.ciphertext)
    .finish();
export const decodeWhisperMessage = (buf) => {
    const reader = new ProtoReader(Buffer.from(buf));
    const out = {};
    for (let f = reader.next(); f; f = reader.next()) {
        if (f.field === 1)
            out.ephemeralKey = f.value;
        else if (f.field === 2)
            out.counter = Number(f.value);
        else if (f.field === 3)
            out.previousCounter = Number(f.value);
        else if (f.field === 4)
            out.ciphertext = f.value;
    }
    return out;
};
export const encodePreKeyWhisperMessage = (msg) => {
    const w = new ProtoWriter();
    if (msg.preKeyId !== undefined)
        w.uint32(1, msg.preKeyId);
    w.bytes(2, msg.baseKey);
    w.bytes(3, msg.identityKey);
    w.bytes(4, msg.message);
    w.uint32(5, msg.registrationId ?? 0);
    w.uint32(6, msg.signedPreKeyId ?? 0);
    return w.finish();
};
export const decodePreKeyWhisperMessage = (buf) => {
    const reader = new ProtoReader(Buffer.from(buf));
    const out = {};
    for (let f = reader.next(); f; f = reader.next()) {
        if (f.field === 1)
            out.preKeyId = Number(f.value);
        else if (f.field === 2)
            out.baseKey = f.value;
        else if (f.field === 3)
            out.identityKey = f.value;
        else if (f.field === 4)
            out.message = f.value;
        else if (f.field === 5)
            out.registrationId = Number(f.value);
        else if (f.field === 6)
            out.signedPreKeyId = Number(f.value);
    }
    return out;
};
//# sourceMappingURL=protobuf.js.map