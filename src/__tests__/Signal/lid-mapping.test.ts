import { jest } from '@jest/globals'
import P from 'pino'
import { LIDMappingStore } from '../../Signal/lid-mapping'
import type { LIDMapping, SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../../Types'

const HOSTED_DEVICE_ID = 99

const mockKeys: jest.Mocked<SignalKeyStoreWithTransaction> = {
	get: jest.fn<SignalKeyStoreWithTransaction['get']>() as any,
	set: jest.fn<SignalKeyStoreWithTransaction['set']>(),
	transaction: jest.fn<SignalKeyStoreWithTransaction['transaction']>(async (work: () => any) => await work()) as any,
	isInTransaction: jest.fn<SignalKeyStoreWithTransaction['isInTransaction']>()
}
const logger = P({ level: 'silent' })

describe('LIDMappingStore', () => {
	const mockPnToLIDFunc = jest.fn<(jids: string[]) => Promise<LIDMapping[] | undefined>>()
	let lidMappingStore: LIDMappingStore

	beforeEach(() => {
		jest.clearAllMocks()
		lidMappingStore = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc)
	})

	describe('getPNForLID', () => {
		it('should correctly map a standard LID with a hosted device ID back to a standard PN with a hosted device', async () => {
			const lidWithHostedDevice = `12345:${HOSTED_DEVICE_ID}@lid`
			const pnUser = '54321'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({ [`12345_reverse`]: pnUser } as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getPNForLID(lidWithHostedDevice)
			expect(result).toBe(`${pnUser}:${HOSTED_DEVICE_ID}@s.whatsapp.net`)
		})

		it('should return null if no reverse mapping is found', async () => {
			const lid = 'nonexistent@lid'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({} as SignalDataTypeMap['lid-mapping']) // Simulate not found in DB

			const result = await lidMappingStore.getPNForLID(lid)
			expect(result).toBeNull()
		})
	})

	describe('getLIDForPN warm-cache fast path', () => {
		it('resolves a cached PN without touching the key store', async () => {
			const store = lidMappingStore as any
			store.mappingCache.set('pn:11111', '22222')

			const result = await lidMappingStore.getLIDForPN('11111:0@s.whatsapp.net')

			expect(result).toBe('22222@lid')
			expect(mockKeys.get).not.toHaveBeenCalled()
		})

		it('preserves the device id of the queried PN in the mapped LID', async () => {
			const store = lidMappingStore as any
			store.mappingCache.set('pn:44444', '33333')

			expect(await lidMappingStore.getLIDForPN('44444:7@s.whatsapp.net')).toBe('33333:7@lid')
			expect(await lidMappingStore.getLIDForPN('44444@s.whatsapp.net')).toBe('33333@lid')
		})

		it('falls back to the full path (USync) on a cache miss', async () => {
			// @ts-ignore
			mockKeys.get.mockResolvedValue({} as SignalDataTypeMap['lid-mapping'])
			mockPnToLIDFunc.mockResolvedValue([{ lid: '99999@lid', pn: '88888@s.whatsapp.net' }])

			const result = await lidMappingStore.getLIDForPN('88888@s.whatsapp.net')

			expect(result).toBe('99999@lid')
			expect(mockPnToLIDFunc).toHaveBeenCalledWith(['88888@s.whatsapp.net'])
		})
	})
})
