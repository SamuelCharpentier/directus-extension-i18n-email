import { describe, it, expect, vi } from 'vitest';
import { fetchDefaultLang, fetchProjectName, fetchUserLang } from '../src/directus';
import type { ExtensionsServices, SchemaOverview } from '@directus/types';

const SCHEMA = {} as SchemaOverview;

function makeSettingsService(returnValue: Record<string, unknown>) {
	const readSingleton = vi.fn().mockResolvedValue(returnValue);
	const SettingsService = vi.fn(function (this: any) {
		this.readSingleton = readSingleton;
	});
	return { SettingsService, readSingleton };
}

function makeItemsService(returnValue: unknown[]) {
	const readByQuery = vi.fn().mockResolvedValue(returnValue);
	const ItemsService = vi.fn(function (this: any) {
		this.readByQuery = readByQuery;
	});
	return { ItemsService, readByQuery };
}

describe('fetchDefaultLang', () => {
	it('returns the primary language tag from default_language', async () => {
		const { SettingsService } = makeSettingsService({ default_language: 'fr-CA' });
		const services = { SettingsService } as unknown as ExtensionsServices;

		expect(await fetchDefaultLang(services, SCHEMA, {})).toBe('fr');
	});

	it('handles a plain language code without region tag', async () => {
		const { SettingsService } = makeSettingsService({ default_language: 'en' });
		const services = { SettingsService } as unknown as ExtensionsServices;

		expect(await fetchDefaultLang(services, SCHEMA, {})).toBe('en');
	});

	it('falls back to "en" when default_language is null and no env variable', async () => {
		const { SettingsService } = makeSettingsService({ default_language: null });
		const services = { SettingsService } as unknown as ExtensionsServices;

		expect(await fetchDefaultLang(services, SCHEMA, {})).toBe('en');
	});

	it('uses I18N_EMAIL_FALLBACK_LANG env variable when default_language is null', async () => {
		const { SettingsService } = makeSettingsService({ default_language: null });
		const services = { SettingsService } as unknown as ExtensionsServices;

		expect(await fetchDefaultLang(services, SCHEMA, { I18N_EMAIL_FALLBACK_LANG: 'fr' })).toBe(
			'fr',
		);
	});

	it('ignores I18N_EMAIL_FALLBACK_LANG when default_language is set', async () => {
		const { SettingsService } = makeSettingsService({ default_language: 'de' });
		const services = { SettingsService } as unknown as ExtensionsServices;

		expect(await fetchDefaultLang(services, SCHEMA, { I18N_EMAIL_FALLBACK_LANG: 'fr' })).toBe(
			'de',
		);
	});

	it('instantiates SettingsService with accountability: null', async () => {
		const { SettingsService } = makeSettingsService({ default_language: 'en' });
		const services = { SettingsService } as unknown as ExtensionsServices;

		await fetchDefaultLang(services, SCHEMA, {});

		expect(SettingsService).toHaveBeenCalledWith(
			expect.objectContaining({ accountability: null }),
		);
	});
});

describe('fetchUserLang', () => {
	it('returns the primary language tag from the matched user', async () => {
		const { ItemsService } = makeItemsService([{ language: 'fr-CA' }]);
		const services = { ItemsService } as unknown as ExtensionsServices;

		expect(await fetchUserLang('user@example.com', services, SCHEMA)).toBe('fr');
	});

	it('handles a plain language code without region tag', async () => {
		const { ItemsService } = makeItemsService([{ language: 'de' }]);
		const services = { ItemsService } as unknown as ExtensionsServices;

		expect(await fetchUserLang('user@example.com', services, SCHEMA)).toBe('de');
	});

	it('returns null when the user has no language set', async () => {
		const { ItemsService } = makeItemsService([{ language: null }]);
		const services = { ItemsService } as unknown as ExtensionsServices;

		expect(await fetchUserLang('user@example.com', services, SCHEMA)).toBeNull();
	});

	it('returns null when no user is found', async () => {
		const { ItemsService } = makeItemsService([]);
		const services = { ItemsService } as unknown as ExtensionsServices;

		expect(await fetchUserLang('unknown@example.com', services, SCHEMA)).toBeNull();
	});

	it('instantiates ItemsService for directus_users with accountability: null', async () => {
		const { ItemsService } = makeItemsService([]);
		const services = { ItemsService } as unknown as ExtensionsServices;

		await fetchUserLang('user@example.com', services, SCHEMA);

		expect(ItemsService).toHaveBeenCalledWith(
			'directus_users',
			expect.objectContaining({ accountability: null }),
		);
	});
});

describe('fetchProjectName', () => {
	it('returns the project name from settings', async () => {
		const { SettingsService } = makeSettingsService({ project_name: 'My Project' });
		const services = { SettingsService } as unknown as ExtensionsServices;

		expect(await fetchProjectName(services, SCHEMA)).toBe('My Project');
	});

	it('returns null when project_name is null', async () => {
		const { SettingsService } = makeSettingsService({ project_name: null });
		const services = { SettingsService } as unknown as ExtensionsServices;

		expect(await fetchProjectName(services, SCHEMA)).toBeNull();
	});

	it('returns null when project_name is an empty string', async () => {
		const { SettingsService } = makeSettingsService({ project_name: '' });
		const services = { SettingsService } as unknown as ExtensionsServices;

		expect(await fetchProjectName(services, SCHEMA)).toBeNull();
	});

	it('instantiates SettingsService with accountability: null', async () => {
		const { SettingsService } = makeSettingsService({ project_name: 'Test' });
		const services = { SettingsService } as unknown as ExtensionsServices;

		await fetchProjectName(services, SCHEMA);

		expect(SettingsService).toHaveBeenCalledWith(
			expect.objectContaining({ accountability: null }),
		);
	});
});
