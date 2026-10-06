import { readFile } from 'fs/promises'
import type { WAMediaUploadFunction } from '../../Types'
import { uploadingNecessaryImages } from '../../Utils/business'

describe('uploadingNecessaryImages', () => {
	it('uploads the full file contents, not a truncated write buffer', async () => {
		// large enough to exceed a single highWaterMark write and force a drain
		const payload = Buffer.alloc(4 * 1024 * 1024, 0xab)

		let uploaded: Buffer | undefined
		const upload: WAMediaUploadFunction = async path => {
			uploaded = await readFile(path)
			return { mediaUrl: 'https://mmg.whatsapp.net/v/t/asset', directPath: '/v/t/asset' }
		}

		const [result] = await uploadingNecessaryImages([payload], upload)

		expect(result).toEqual({ url: 'https://mmg.whatsapp.net/v/t/asset' })
		expect(uploaded?.length).toBe(payload.length)
		expect(uploaded?.equals(payload)).toBe(true)
	})

	it('reuses an existing whatsapp.net url without re-uploading', async () => {
		let called = false
		const upload: WAMediaUploadFunction = async () => {
			called = true
			return { mediaUrl: 'https://mmg.whatsapp.net/v/t/asset', directPath: '/v/t/asset' }
		}

		const [result] = await uploadingNecessaryImages([{ url: new URL('https://mmg.whatsapp.net/v/t/existing') }], upload)

		expect(result).toEqual({ url: 'https://mmg.whatsapp.net/v/t/existing' })
		expect(called).toBe(false)
	})
})
