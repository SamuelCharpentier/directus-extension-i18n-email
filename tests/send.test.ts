import { describe, it, expect, vi } from 'vitest';
import type { EmailOptions } from '@directus/types';
import { emptySchema, makeLogger, makeServices } from './helpers';
import { runSendFilter } from '../src/send';

type SetupArgs = {
	userLang?: string | null;
	defaultLang?: string;
	projectName?: string | null;
	templateRows?: Record<string, Record<string, any>>; // [key][lang] = row
	variables?: any[];
};

function setup(opts: SetupArgs = {}) {
	const { userLang = null, defaultLang = 'en', projectName = 'Proj' } = opts;

	const templateReadByQuery = vi.fn().mockImplementation((query: any) => {
		const key = query?.filter?.template_key?._eq;
		const lang = query?.filter?.language?._eq;
		const row = opts.templateRows?.[key]?.[lang];
		return Promise.resolve(row ? [row] : []);
	});

	const variablesReadByQuery = vi.fn().mockResolvedValue(opts.variables ?? []);

	const usersReadByQuery = vi.fn().mockImplementation((query: any) => {
		// For fetchUserLang OR fetchAdminEmails
		if (query?.fields?.includes?.('email')) {
			return Promise.resolve([{ email: 'admin@x.com' }]);
		}
		return Promise.resolve(userLang ? [{ language: userLang }] : []);
	});

	const settingsReadSingleton = vi.fn().mockImplementation((q: any) => {
		const fields = q?.fields ?? [];
		if (fields.includes('default_language'))
			return Promise.resolve({ default_language: defaultLang });
		if (fields.includes('project_name'))
			return Promise.resolve({ project_name: projectName ?? '' });
		return Promise.resolve({});
	});

	return makeServices({
		settings: { readSingleton: settingsReadSingleton },
		items: {
			email_templates: { readByQuery: templateReadByQuery },
			email_template_variables: { readByQuery: variablesReadByQuery },
			directus_users: { readByQuery: usersReadByQuery },
		},
	});
}

function baseInput(templateName?: string): EmailOptions {
	return {
		to: 'user@x.com',
		subject: 'Orig',
		template: templateName
			? { name: templateName, data: { url: 'https://ex.com' } }
			: undefined,
	} as EmailOptions;
}

const deps = (services: any, env: Record<string, unknown> = {}) => ({
	services,
	getSchema: vi.fn().mockResolvedValue(emptySchema),
	logger: makeLogger(),
	env,
});

describe('runSendFilter', () => {
	it('passes through when the email has no template', async () => {
		const { services } = setup();
		const input = baseInput();
		const out = await runSendFilter(input, deps(services));
		expect(out).toBe(input);
	});

	it('passes through admin-error sends to avoid recursion', async () => {
		const { services } = setup();
		const input = baseInput('admin-error');
		const out = await runSendFilter(input, deps(services));
		expect(out.subject).toBe('Orig');
	});

	it('passes through when no DB row matches either lang', async () => {
		const { services } = setup();
		const input = baseInput('unknown');
		const out = await runSendFilter(input, deps(services));
		expect(out.subject).toBe('Orig');
	});

	it('applies DB translations in the user language when available', async () => {
		const row = {
			template_key: 'password-reset',
			language: 'fr',
			subject: 'Reset FR',
			from_name: 'Org FR',
			strings: { heading: 'H-fr' },
		};
		const base = {
			template_key: 'base',
			language: 'fr',
			subject: '',
			from_name: 'Org FR',
			strings: { footer: 'F-fr' },
		};
		const { services } = setup({
			userLang: 'fr',
			templateRows: { 'password-reset': { fr: row }, base: { fr: base } },
		});
		const input = baseInput('password-reset');
		const out = await runSendFilter(input, deps(services, { EMAIL_FROM: 'noreply@x.com' }));
		expect(out.subject).toBe('Reset FR');
		expect((out as any).from).toEqual({ name: 'Org FR', address: 'noreply@x.com' });
		expect(out.template?.data).toMatchObject({
			i18n: { heading: 'H-fr', base: { footer: 'F-fr' } },
		});
	});

	it('falls back to the default language when user lang has no row', async () => {
		const row = {
			template_key: 'password-reset',
			language: 'en',
			subject: 'Reset EN',
			from_name: null,
			strings: { heading: 'H-en' },
		};
		const { services } = setup({
			userLang: 'fr',
			defaultLang: 'en',
			templateRows: { 'password-reset': { en: row } },
		});
		const input = baseInput('password-reset');
		const out = await runSendFilter(input, deps(services, { EMAIL_FROM: 'x@y.com' }));
		expect(out.subject).toBe('Reset EN');
		// Falls back to projectName for from_name since row.from_name is null.
		expect((out as any).from).toEqual({ name: 'Proj', address: 'x@y.com' });
	});

	it('uses I18N_EMAIL_FALLBACK_FROM_NAME when row and project name are unset', async () => {
		const row = {
			template_key: 'password-reset',
			language: 'en',
			subject: 'Reset EN',
			from_name: null,
			strings: { heading: 'H' },
		};
		const { services } = setup({
			defaultLang: 'en',
			projectName: null,
			templateRows: { 'password-reset': { en: row } },
		});
		const out = await runSendFilter(
			baseInput('password-reset'),
			deps(services, { EMAIL_FROM: 'n@x.com', I18N_EMAIL_FALLBACK_FROM_NAME: 'Env Org' }),
		);
		expect((out as any).from).toEqual({ name: 'Env Org', address: 'n@x.com' });
	});

	it('throws and notifies admins when a required variable is missing', async () => {
		const row = {
			template_key: 'password-reset',
			language: 'en',
			subject: 'x',
			from_name: null,
			strings: {},
		};
		const { services, mailInstance } = setup({
			templateRows: { 'password-reset': { en: row } },
			variables: [
				{ template_key: 'password-reset', variable_name: 'url', is_required: true },
				{ template_key: 'password-reset', variable_name: 'token', is_required: true },
			],
		});
		const input = {
			to: 'user@x.com',
			subject: 'Orig',
			template: { name: 'password-reset', data: { url: 'x' } },
		} as EmailOptions;
		const d = deps(services, { EMAIL_FROM: 'f@x.com' });
		await expect(runSendFilter(input, d)).rejects.toThrow(/Missing required variable/);
		// notifyAdmins is fire-and-forget; let the microtask settle.
		await new Promise((r) => setImmediate(r));
		expect(mailInstance.send).toHaveBeenCalled();
	});

	it('catches and logs unexpected errors (non-validation) without throwing', async () => {
		const settingsReadSingleton = vi.fn().mockRejectedValue(new Error('db down'));
		const services = makeServices({
			settings: { readSingleton: settingsReadSingleton },
		}).services;
		const d = deps(services);
		const input = baseInput('password-reset');
		const out = await runSendFilter(input, d);
		expect(out).toBe(input);
		expect(d.logger.error).toHaveBeenCalled();
	});

	it('skips fetchUserLang when no recipient email can be extracted', async () => {
		const row = {
			template_key: 'password-reset',
			language: 'en',
			subject: 'S',
			from_name: 'Org',
			strings: {},
		};
		const { services } = setup({
			defaultLang: 'en',
			templateRows: { 'password-reset': { en: row } },
		});
		const input = {
			to: {} as any,
			subject: 'x',
			template: { name: 'password-reset', data: { url: 'x' } },
		} as EmailOptions;
		const out = await runSendFilter(input, deps(services, { EMAIL_FROM: 'f@x.com' }));
		expect(out.subject).toBe('S');
	});

	it('handles template with no data key at all (no variables required)', async () => {
		const row = {
			template_key: 'password-reset',
			language: 'en',
			subject: 'S',
			from_name: 'Org',
			strings: {},
		};
		const { services } = setup({
			defaultLang: 'en',
			templateRows: { 'password-reset': { en: row } },
			variables: [],
		});
		const input = {
			to: 'u@x.com',
			subject: 'x',
			template: { name: 'password-reset' },
		} as EmailOptions;
		const out = await runSendFilter(input, deps(services, { EMAIL_FROM: 'f@x.com' }));
		expect(out.subject).toBe('S');
	});

	it('skips default-lang fallback when user lang already equals default', async () => {
		const { services } = setup({
			userLang: null,
			defaultLang: 'en',
			templateRows: {},
		});
		const input = baseInput('password-reset');
		const d = deps(services);
		const out = await runSendFilter(input, d);
		expect(out).toBe(input);
		expect(d.logger.info).toHaveBeenCalledWith(expect.stringContaining('passing through'));
	});

	it('emits no from header when row/env/project all unset', async () => {
		const row = {
			template_key: 'password-reset',
			language: 'en',
			subject: '', // falsy subject → exercise rowToTrans no-subject branch
			from_name: null,
			strings: { heading: 'H' },
		};
		const { services } = setup({
			defaultLang: 'en',
			projectName: null,
			templateRows: { 'password-reset': { en: row } },
		});
		const input = baseInput('password-reset');
		const out = await runSendFilter(input, deps(services, {}));
		// Subject untouched (row.subject empty), from not set (all fallbacks undefined)
		expect(out.subject).toBe('Orig');
		expect((out as any).from).toBeUndefined();
	});
});
