/**
 * Re-evaluating the i18n module (Fast Refresh, a second bundle copy) must not reset the language
 * the user chose. The module initialises the shared i18next singleton at module scope; a second
 * evaluation used to re-run init() with the device language.
 */
describe('i18n module re-evaluation', () => {
	afterEach(() => {
		jest.dontMock('i18next');
		jest.resetModules();
	});

	it('keeps the chosen language when the module is evaluated a second time on the same instance', async () => {
		const i18n = require('i18next').default ?? require('i18next');
		require('../index');
		expect(i18n.isInitialized).toBe(true);
		await i18n.changeLanguage('es');
		expect(i18n.language).toBe('es');

		jest.isolateModules(() => {
			jest.doMock('i18next', () => ({ __esModule: true, default: i18n }));
			require('../index');
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(i18n.language).toBe('es');
	});

	it('first evaluation on a fresh instance initialises with the device language', () => {
		jest.isolateModules(() => {
			const fresh = require('i18next').default ?? require('i18next');
			expect(fresh.isInitialized).toBeFalsy();
			const mod = require('../index').default;
			expect(mod.isInitialized).toBe(true);
			expect(mod.language).toBe('en');
		});
	});
});
