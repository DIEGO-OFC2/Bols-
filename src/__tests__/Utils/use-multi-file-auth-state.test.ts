import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { useMultiFileAuthState } from '../../Utils/use-multi-file-auth-state'

describe('useMultiFileAuthState', () => {
	it('serializes concurrent writes to the same key file', async () => {
		const folder = await mkdtemp(join(tmpdir(), 'baileys-auth-'))
		try {
			const { state } = await useMultiFileAuthState(folder)

			const writes = Array.from({ length: 25 }, (_, i) =>
				state.keys.set({ session: { 'user@s.whatsapp.net': { n: i } as never } })
			)
			await Promise.all(writes)

			const raw = await readFile(join(folder, 'session-user@s.whatsapp.net.json'), 'utf-8')
			expect(() => JSON.parse(raw)).not.toThrow()
			expect(JSON.parse(raw)).toMatchObject({ n: expect.any(Number) })
		} finally {
			await rm(folder, { recursive: true, force: true })
		}
	})

	it('round-trips a value written through the key store', async () => {
		const folder = await mkdtemp(join(tmpdir(), 'baileys-auth-'))
		try {
			const { state } = await useMultiFileAuthState(folder)

			await state.keys.set({ 'pre-key': { '1': { private: 'abc', public: 'def' } as never } })

			const result = await state.keys.get('pre-key', ['1'])
			expect((result as Record<string, unknown>)['1']).toMatchObject({ private: 'abc', public: 'def' })
		} finally {
			await rm(folder, { recursive: true, force: true })
		}
	})
})
