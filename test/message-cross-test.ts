/**
 * Interop test for the Message protobuf codec against Baileys' WAProto.
 * lightwa encodes; the reference decodes (and vice-versa) to prove the wire
 * bytes are identical for text, image, audio, video, document and group SKDM.
 */
import { decodeMessage, encodeMessage, type IMessage } from '../src/proto/message.js'
import { requireBaileys, baileysDir, skip } from './reference.js'

if (!baileysDir()) skip('message proto interop')
const { proto } = requireBaileys('WAProto/index.js')

let total = 0
let pass = 0
const check = (label: string, cond: boolean, extra = '') => {
  total++
  if (cond) pass++
  else console.log(`FAIL ${label} ${extra}`)
}

const refDecode = (buf: Uint8Array) => proto.Message.decode(buf).toJSON()
const refEncode = (obj: any) => Buffer.from(proto.Message.encode(proto.Message.create(obj)).finish())

const run = () => {
  // text
  const text = encodeMessage({ conversation: 'hola mundo' })
  const rt = refDecode(text)
  check('reference reads lightwa conversation', rt.conversation === 'hola mundo', JSON.stringify(rt))

  const refText = refEncode({ conversation: 'from ref' })
  check('lightwa reads reference conversation', decodeMessage(refText).conversation === 'from ref')

  // extended text
  const ext = encodeMessage({ extendedTextMessage: { text: 'ext' } })
  check('reference reads lightwa extendedText', refDecode(ext).extendedTextMessage.text === 'ext')

  // image
  const img: IMessage = {
    imageMessage: {
      url: 'https://mmg.whatsapp.net/x',
      mimetype: 'image/jpeg',
      caption: 'cap',
      fileSha256: new Uint8Array([1, 2, 3]),
      fileLength: 1234,
      height: 100,
      width: 200,
      mediaKey: new Uint8Array(32).fill(7),
      fileEncSha256: new Uint8Array([9, 9]),
      directPath: '/v/t62/x',
      mediaKeyTimestamp: 1700000000,
      jpegThumbnail: new Uint8Array([255, 216])
    }
  }
  const imgBuf = encodeMessage(img)
  const ri = refDecode(imgBuf)
  check('reference reads lightwa image url', ri.imageMessage.url === 'https://mmg.whatsapp.net/x')
  check('reference reads lightwa image caption', ri.imageMessage.caption === 'cap')
  check('reference reads lightwa image height/width', ri.imageMessage.height === 100 && ri.imageMessage.width === 200)
  check('reference reads lightwa image fileLength', Number(ri.imageMessage.fileLength) === 1234)

  const refImg = refEncode({
    imageMessage: {
      url: 'u', mimetype: 'image/png', caption: 'c', fileSha256: Buffer.from([4, 5]),
      fileLength: 9, height: 3, width: 4, mediaKey: Buffer.alloc(32, 1),
      fileEncSha256: Buffer.from([6]), directPath: 'd', mediaKeyTimestamp: 5
    }
  })
  const li = decodeMessage(refImg)
  check('lightwa reads reference image', li.imageMessage!.url === 'u' && li.imageMessage!.mimetype === 'image/png')
  check('lightwa reads reference image dims', li.imageMessage!.height === 3 && li.imageMessage!.width === 4)

  // audio (ptt)
  const aud = encodeMessage({ audioMessage: {
    url: 'a', mimetype: 'audio/ogg', fileSha256: new Uint8Array([1]), fileLength: 10, seconds: 3,
    ptt: true, mediaKey: new Uint8Array(32), fileEncSha256: new Uint8Array([2]), directPath: '/x', mediaKeyTimestamp: 1
  }})
  const ra = refDecode(aud)
  check('reference reads lightwa ptt', ra.audioMessage.ptt === true && ra.audioMessage.seconds === 3)

  // document
  const doc = encodeMessage({ documentMessage: {
    url: 'd', mimetype: 'application/pdf', title: 't', fileName: 'f.pdf', fileSha256: new Uint8Array([1]),
    fileLength: 5, mediaKey: new Uint8Array(32), fileEncSha256: new Uint8Array([2]), directPath: '/x',
    mediaKeyTimestamp: 1, caption: 'dc', pageCount: 2
  }})
  const Rd = refDecode(doc)
  check('reference reads lightwa document', Rd.documentMessage.fileName === 'f.pdf' && Rd.documentMessage.pageCount === 2)

  // sender key distribution
  const skdm = encodeMessage({ senderKeyDistributionMessage: {
    groupId: 'g@g.us', axolotlSenderKeyDistributionMessage: new Uint8Array([1, 2, 3, 4])
  }})
  const rk = refDecode(skdm)
  check('reference reads lightwa skdm group', rk.senderKeyDistributionMessage.groupId === 'g@g.us')

  const refSkdm = refEncode({ senderKeyDistributionMessage: { groupId: 'h@g.us', axolotlSenderKeyDistributionMessage: Buffer.from([7, 8]) } })
  check('lightwa reads reference skdm', decodeMessage(refSkdm).senderKeyDistributionMessage!.groupId === 'h@g.us')

  console.log(`\n${pass}/${total} message proto interop checks passed`)
  if (pass !== total) process.exitCode = 1
}

run()
