import type { BinaryNode } from '../wabinary/types.js'

/**
 * Build an ACK for a received stanza, mirroring WhatsApp Web's
 * `WAWebHandleMsgSendAck.sendAck` / `sendNack`:
 * - `class` always carries the source tag
 * - `participant`/`recipient`/`type` are forwarded when present
 * - a non-zero `errorCode` turns the ACK into a NACK
 * - message-class ACKs carry our own id as `from`
 */
export const buildAckStanza = (node: BinaryNode, errorCode?: number, meId?: string): BinaryNode => {
  const { tag, attrs } = node
  const ack: BinaryNode = {
    tag: 'ack',
    attrs: {
      id: attrs.id!,
      to: attrs.from!,
      class: tag
    }
  }

  if (errorCode) ack.attrs.error = errorCode.toString()
  if (attrs.participant) ack.attrs.participant = attrs.participant
  if (attrs.recipient) ack.attrs.recipient = attrs.recipient
  if (attrs.type) ack.attrs.type = attrs.type
  if (tag === 'message' && meId) ack.attrs.from = meId

  return ack
}
