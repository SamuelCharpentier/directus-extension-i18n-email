import { describe, it, expect } from 'vitest';
import { makeServices, makeLogger, makeSchema } from './helpers';
import { ensureDefaultLanguage } from '../src/default-language';
import { fetchDefaultLang } from '../src/directus';

describe('ensureDefaultLanguage', () => {
	it('is a no-op when DEFAULT_LANGUAGE is unset', async () => {
		const s = makeServices();
		const logger = makeLogger();
		expect(await ensureDefaultLanguage(s as any, makeSchema(), {}, logger)).toBeNull();
		expect(s._settingsUpserts.length).toBe(0);
	});

	it('writes when the env value differs from settings', async () => {
		const s = makeServices({
			settings: { readSingleton: async () => ({ default_language: 'en-US' }) },
		});
		const logger = makeLogger();
		const out = await ensureDefaultLanguage(
			s as any,
			makeSchema(),
			{ DEFAULT_LANGUAGE: 'fr-CA' },
			logger,
		);
		expect(out).toBe('fr-CA');
		expect(s._settingsUpserts).toEqual([
			{ payload: { default_language: 'fr-CA' }, opts: { emitEvents: false } },
		]);
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Set default language'));
	});

	it('does not write when settings already match', async () => {
		const s = makeServices({
			settings: { readSingleton: async () => ({ default_language: 'fr-CA' }) },
		});
		const logger = makeLogger();
		expect(
			await ensureDefaultLanguage(s as any, makeSchema(), { DEFAULT_LANGUAGE: 'fr-CA' }, logger),
		).toBe('fr-CA');
		expect(s._settingsUpserts.length).toBe(0);
	});

	it('canonicalizes a lower-case tag before comparing', async () => {
		const s = makeServices({
			settings: { readSingleton: async () => ({ default_language: 'fr-CA' }) },
		});
		const logger = makeLogger();
		expect(
			await ensureDefaultLanguage(s as any, makeSchema(), { DEFAULT_LANGUAGE: 'fr-ca' }, logger),
		).toBe('fr-CA');
		// Canonical form matches the stored value → nothing written.
		expect(s._settingsUpserts.length).toBe(0);
	});

	it('warns and no-ops on an invalid tag', async () => {
		const s = makeServices();
		const logger = makeLogger();
		expect(
			await ensureDefaultLanguage(s as any, makeSchema(), { DEFAULT_LANGUAGE: '!!' }, logger),
		).toBeNull();
		expect(s._settingsUpserts.length).toBe(0);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not a valid BCP-47 tag'));
	});

	it('warns and no-ops when the settings read throws', async () => {
		const s = makeServices({
			settings: {
				readSingleton: async () => {
					throw new Error('db down');
				},
			},
		});
		const logger = makeLogger();
		expect(
			await ensureDefaultLanguage(s as any, makeSchema(), { DEFAULT_LANGUAGE: 'fr-CA' }, logger),
		).toBeNull();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Could not apply DEFAULT_LANGUAGE'),
		);
	});
});

describe('fetchDefaultLang precedence', () => {
	it('prefers DEFAULT_LANGUAGE over settings and fallback', async () => {
		const s = makeServices({
			settings: { readSingleton: async () => ({ default_language: 'en-US' }) },
		});
		expect(
			await fetchDefaultLang(s as any, makeSchema(), {
				DEFAULT_LANGUAGE: 'fr-CA',
				I18N_EMAIL_FALLBACK_LANG: 'de-DE',
			}),
		).toBe('fr-CA');
	});

	it('ignores an invalid DEFAULT_LANGUAGE and falls back to settings', async () => {
		const s = makeServices({
			settings: { readSingleton: async () => ({ default_language: 'fr-CA' }) },
		});
		expect(await fetchDefaultLang(s as any, makeSchema(), { DEFAULT_LANGUAGE: '!!' })).toBe(
			'fr-CA',
		);
	});
});
