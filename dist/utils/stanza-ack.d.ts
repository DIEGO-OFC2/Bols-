import type { BinaryNode } from '../wabinary/types.js';
/**
 * Build an ACK for a received stanza, mirroring WhatsApp Web's
 * `WAWebHandleMsgSendAck.sendAck` / `sendNack`:
 * - `class` always carries the source tag
 * - `participant`/`recipient`/`type` are forwarded when present
 * - a non-zero `errorCode` turns the ACK into a NACK
 * - message-class ACKs carry our own id as `from`
 */
export declare const buildAckStanza: (node: BinaryNode, errorCode?: number, meId?: string) => BinaryNode;
//# sourceMappingURL=stanza-ack.d.ts.map