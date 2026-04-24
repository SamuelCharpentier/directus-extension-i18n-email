import { describe, it, expect } from 'vitest';
import { makeServices, emptySchema } from './helpers';
import {
	fetchDefaultLang,
	fetchUserLang,
	fetchProjectName,
	fetchTemplateRow,
	fetchAllTemplateRows,
	fetchTemplateVariables,
	fetchAdminEmails,
} from '../src/directus';
import { vi } from 'vitest';

describe('fetchDefaultLang', () => {
	it('returns the primary subtag of directus_settings.default_language', async () => {
		const { services } = makeServices({
			settings: { readSingleton: vi.fn().mockResolvedValue({ default_language: 'fr-CA' }) },
		});
		expect(await fetchDefaultLang(services, emptySchema, {})).toBe('fr');
	});

	it('falls back to env I18N_EMAIL_FALLBACK_LANG when setting is missing', async () => {
		const { services } = makeServices({
			settings: { readSingleton: vi.fn().mockResolvedValue({}) },
		});
		expect(
			await fetchDefaultLang(services, emptySchema, { I18N_EMAIL_FALLBACK_LANG: 'es' }),
		).toBe('es');
	});

	it('falls back to hardcoded "en" when nothing else is configured', async () => {
		const { services } = makeServices({
			settings: { readSingleton: vi.fn().mockResolvedValue({}) },
		});
		expect(await fetchDefaultLang(services, emptySchema, {})).toBe('en');
	});
});

describe('fetchUserLang', () => {
	it('returns the primary subtag of a matched user', async () => {
		const { services } = makeServices({
			items: {
				directus_users: { readByQuery: vi.fn().mockResolvedValue([{ language: 'fr-CA' }]) },
			},
		});
		expect(await fetchUserLang('x@y.com', services, emptySchema)).toBe('fr');
	});

	it('returns null when no user matches', async () => {
		const { services } = makeServices({
			items: { directus_users: { readByQuery: vi.fn().mockResolvedValue([]) } },
		});
		expect(await fetchUserLang('x@y.com', services, emptySchema)).toBe(null);
	});

	it('returns null when the user row has no language', async () => {
		const { services } = makeServices({
			items: { directus_users: { readByQuery: vi.fn().mockResolvedValue([{}]) } },
		});
		expect(await fetchUserLang('x@y.com', services, emptySchema)).toBe(null);
	});
});

describe('fetchProjectName', () => {
	it('returns the project_name string when present', async () => {
		const { services } = makeServices({
			settings: { readSingleton: vi.fn().mockResolvedValue({ project_name: 'Acme' }) },
		});
		expect(await fetchProjectName(services, emptySchema)).toBe('Acme');
	});

	it('returns null for empty or missing values', async () => {
		const { services: s1 } = makeServices({
			settings: { readSingleton: vi.fn().mockResolvedValue({ project_name: '' }) },
		});
		expect(await fetchProjectName(s1, emptySchema)).toBe(null);
		const { services: s2 } = makeServices({
			settings: { readSingleton: vi.fn().mockResolvedValue({}) },
		});
		expect(await fetchProjectName(s2, emptySchema)).toBe(null);
	});
});

describe('fetchTemplateRow', () => {
	it('returns the first row from readByQuery', async () => {
		const row = { template_key: 'k', language: 'fr' };
		const { services } = makeServices({
			items: { email_templates: { readByQuery: vi.fn().mockResolvedValue([row]) } },
		});
		expect(await fetchTemplateRow('k', 'fr', services, emptySchema)).toEqual(row);
	});

	it('returns null when no row matches', async () => {
		const { services } = makeServices({
			items: { email_templates: { readByQuery: vi.fn().mockResolvedValue([]) } },
		});
		expect(await fetchTemplateRow('k', 'fr', services, emptySchema)).toBe(null);
	});
});

describe('fetchAllTemplateRows', () => {
	it('returns all active rows', async () => {
		const rows = [{ id: '1' }, { id: '2' }];
		const { services } = makeServices({
			items: { email_templates: { readByQuery: vi.fn().mockResolvedValue(rows) } },
		});
		expect(await fetchAllTemplateRows(services, emptySchema)).toEqual(rows);
	});
});

describe('fetchTemplateVariables', () => {
	it('returns registry rows for a template key', async () => {
		const rows = [{ variable_name: 'url', is_required: true }];
		const { services } = makeServices({
			items: { email_template_variables: { readByQuery: vi.fn().mockResolvedValue(rows) } },
		});
		expect(await fetchTemplateVariables('k', services, emptySchema)).toEqual(rows);
	});
});

describe('fetchAdminEmails', () => {
	it('returns emails of active admin users, filtering out non-strings', async () => {
		const { services } = makeServices({
			items: {
				directus_users: {
					readByQuery: vi
						.fn()
						.mockResolvedValue([
							{ email: 'a@x.com' },
							{ email: '' },
							{ email: null },
							{},
							{ email: 'b@x.com' },
						]),
				},
			},
		});
		expect(await fetchAdminEmails(services, emptySchema)).toEqual(['a@x.com', 'b@x.com']);
	});
});
