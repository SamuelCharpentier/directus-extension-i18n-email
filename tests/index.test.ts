import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmailOptions } from '@directus/types';

vi.mock('../src/directus', () => ({
	fetchDefaultLang: vi.fn(),
	fetchUserLang: vi.fn(),
	fetchProjectName: vi.fn(),
}));
vi.mock('../src/email', () => ({
	extractRecipientEmail: vi.fn(),
	applyTranslationsToEmail: vi.fn(),
}));
vi.mock('../src/locale', () => ({
	resolveLocale: vi.fn(),
	extractTemplateTrans: vi.fn(),
}));

import hook from '../src/index';
import { fetchDefaultLang, fetchProjectName, fetchUserLang } from '../src/directus';
import { extractRecipientEmail, applyTranslationsToEmail } from '../src/email';
import { resolveLocale, extractTemplateTrans } from '../src/locale';

const mockFetchDefaultLang = vi.mocked(fetchDefaultLang);
const mockFetchUserLang = vi.mocked(fetchUserLang);
const mockFetchProjectName = vi.mocked(fetchProjectName);
const mockExtractRecipientEmail = vi.mocked(extractRecipientEmail);
const mockApplyTranslations = vi.mocked(applyTranslationsToEmail);
const mockResolveLocale = vi.mocked(resolveLocale);
const mockExtractTemplateTrans = vi.mocked(extractTemplateTrans);

function makeEmail(templateName: string): EmailOptions {
	return {
		to: 'user@example.com',
		template: { name: templateName, data: {} },
	} as EmailOptions;
}

function setupHook() {
	let filterCallback: ((input: EmailOptions) => Promise<EmailOptions>) | undefined;
	const filter = vi.fn((_event: string, cb: typeof filterCallback) => {
		filterCallback = cb;
	});
	const logger = { error: vi.fn() };
	const getSchema = vi.fn().mockResolvedValue({});
	const env = { EMAIL_TEMPLATES_PATH: '/templates', EMAIL_FROM: 'noreply@example.com' };

	hook({ filter } as any, { services: {} as any, logger, getSchema, env } as any);

	return { invoke: filterCallback!, logger, getSchema, env };
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchDefaultLang.mockResolvedValue('en');
	mockFetchUserLang.mockResolvedValue(null);
	mockFetchProjectName.mockResolvedValue('My Project');
	mockExtractRecipientEmail.mockReturnValue('user@example.com');
	mockResolveLocale.mockResolvedValue(null);
	mockExtractTemplateTrans.mockReturnValue(null);
});

describe('hook filter registration', () => {
	it('registers a filter for email.send', () => {
		const filter = vi.fn();
		hook(
			{ filter } as any,
			{ services: {} as any, logger: { error: vi.fn() }, getSchema: vi.fn(), env: {} } as any,
		);
		expect(filter).toHaveBeenCalledWith('email.send', expect.any(Function));
	});
});

describe('email.send filter', () => {
	it('returns input unchanged for non-system templates', async () => {
		const { invoke } = setupHook();
		const input = makeEmail('custom-template');
		const result = await invoke(input);
		expect(result).toBe(input);
		expect(mockFetchDefaultLang).not.toHaveBeenCalled();
	});

	it('returns input unchanged when template is missing', async () => {
		const { invoke } = setupHook();
		const input = { to: 'user@example.com' } as EmailOptions;
		const result = await invoke(input);
		expect(result).toBe(input);
		expect(mockFetchDefaultLang).not.toHaveBeenCalled();
	});

	it('processes all three system email templates', async () => {
		const { invoke } = setupHook();
		for (const name of ['password-reset', 'user-invitation', 'user-registration']) {
			vi.clearAllMocks();
			mockFetchDefaultLang.mockResolvedValue('en');
			mockFetchUserLang.mockResolvedValue(null);
			mockFetchProjectName.mockResolvedValue(null);
			mockExtractRecipientEmail.mockReturnValue('user@example.com');
			mockResolveLocale.mockResolvedValue(null);
			await invoke(makeEmail(name));
			expect(mockFetchDefaultLang).toHaveBeenCalledOnce();
		}
	});

	it('skips fetchUserLang and uses defaultLang when recipient email cannot be extracted', async () => {
		const { invoke } = setupHook();
		mockExtractRecipientEmail.mockReturnValue(null as any);
		mockFetchDefaultLang.mockResolvedValue('en');
		mockResolveLocale.mockResolvedValue(null);
		await invoke(makeEmail('password-reset'));
		expect(mockFetchUserLang).not.toHaveBeenCalled();
		expect(mockResolveLocale).toHaveBeenCalledWith('/templates', 'en', 'en');
	});

	it('returns input unchanged when no locale is found', async () => {
		const { invoke } = setupHook();
		mockResolveLocale.mockResolvedValue(null);
		const input = makeEmail('password-reset');
		const result = await invoke(input);
		expect(result).toBe(input);
		expect(mockApplyTranslations).not.toHaveBeenCalled();
	});

	it('returns input unchanged when no template trans is found', async () => {
		const { invoke } = setupHook();
		mockResolveLocale.mockResolvedValue({ from_name: 'Test' });
		mockExtractTemplateTrans.mockReturnValue(null);
		const input = makeEmail('password-reset');
		const result = await invoke(input);
		expect(result).toBe(input);
		expect(mockApplyTranslations).not.toHaveBeenCalled();
	});

	it('applies translations when locale and trans are available', async () => {
		const { invoke } = setupHook();
		const locale = { 'password-reset': { subject: 'Reset', from_name: 'Sender' } };
		const trans = { subject: 'Reset', from_name: 'Sender' };
		mockResolveLocale.mockResolvedValue(locale);
		mockExtractTemplateTrans.mockReturnValue(trans);
		const input = makeEmail('password-reset');
		await invoke(input);
		expect(mockApplyTranslations).toHaveBeenCalledWith(input, trans, 'noreply@example.com');
	});

	it('uses I18N_EMAIL_FALLBACK_FROM_NAME env variable when trans has no from_name', async () => {
		let cb: ((input: EmailOptions) => Promise<EmailOptions>) | undefined;
		const filter2 = vi.fn((_e: string, c: typeof cb) => {
			cb = c;
		});
		hook(
			{ filter: filter2 } as any,
			{
				services: {} as any,
				logger: { error: vi.fn() },
				getSchema: vi.fn().mockResolvedValue({}),
				env: { EMAIL_FROM: 'a@b.com', I18N_EMAIL_FALLBACK_FROM_NAME: 'Env Name' },
			} as any,
		);
		const trans = { subject: 'S' };
		mockResolveLocale.mockResolvedValue({ 'password-reset': trans });
		mockExtractTemplateTrans.mockReturnValue(trans);
		mockExtractRecipientEmail.mockReturnValue('u@example.com');
		await cb!(makeEmail('password-reset'));
		expect(mockApplyTranslations).toHaveBeenCalledWith(
			expect.anything(),
			{ ...trans, from_name: 'Env Name' },
			'a@b.com',
		);
	});

	it('falls back to project name when trans and env have no from_name', async () => {
		const { invoke } = setupHook();
		mockFetchProjectName.mockResolvedValue('Project Name');
		const trans = { subject: 'S' };
		mockResolveLocale.mockResolvedValue({ 'password-reset': trans });
		mockExtractTemplateTrans.mockReturnValue(trans);
		await invoke(makeEmail('password-reset'));
		expect(mockApplyTranslations).toHaveBeenCalledWith(
			expect.anything(),
			{ ...trans, from_name: 'Project Name' },
			'noreply@example.com',
		);
	});

	it('passes trans unchanged when from_name is already set', async () => {
		const { invoke } = setupHook();
		const trans = { subject: 'S', from_name: 'From Locale' };
		mockResolveLocale.mockResolvedValue({ 'password-reset': trans });
		mockExtractTemplateTrans.mockReturnValue(trans);
		await invoke(makeEmail('password-reset'));
		expect(mockApplyTranslations).toHaveBeenCalledWith(
			expect.anything(),
			trans,
			'noreply@example.com',
		);
	});

	it('sets from_name to undefined when neither env nor project name are available', async () => {
		const { invoke } = setupHook();
		mockFetchProjectName.mockResolvedValue(null);
		const trans = { subject: 'S' };
		mockResolveLocale.mockResolvedValue({ 'password-reset': trans });
		mockExtractTemplateTrans.mockReturnValue(trans);
		await invoke(makeEmail('password-reset'));
		expect(mockApplyTranslations).toHaveBeenCalledWith(
			expect.anything(),
			{ ...trans, from_name: undefined },
			'noreply@example.com',
		);
	});

	it('uses userLang when available instead of defaultLang', async () => {
		const { invoke } = setupHook();
		mockFetchUserLang.mockResolvedValue('fr');
		mockFetchDefaultLang.mockResolvedValue('en');
		await invoke(makeEmail('password-reset'));
		expect(mockResolveLocale).toHaveBeenCalledWith('/templates', 'fr', 'en');
	});

	it('falls back to defaultLang when userLang is null', async () => {
		const { invoke } = setupHook();
		mockFetchUserLang.mockResolvedValue(null);
		mockFetchDefaultLang.mockResolvedValue('en');
		await invoke(makeEmail('password-reset'));
		expect(mockResolveLocale).toHaveBeenCalledWith('/templates', 'en', 'en');
	});

	it('fetches langs and project name in parallel', async () => {
		const { invoke } = setupHook();
		const order: string[] = [];
		mockFetchDefaultLang.mockImplementation(async () => {
			order.push('default');
			return 'en';
		});
		mockFetchUserLang.mockImplementation(async () => {
			order.push('user');
			return null;
		});
		mockFetchProjectName.mockImplementation(async () => {
			order.push('project');
			return null;
		});
		await invoke(makeEmail('password-reset'));
		expect(order).toContain('default');
		expect(order).toContain('user');
		expect(order).toContain('project');
	});

	it('logs error and returns input when an exception is thrown', async () => {
		const { invoke, logger } = setupHook();
		mockFetchDefaultLang.mockRejectedValue(new Error('db error'));
		const input = makeEmail('password-reset');
		const result = await invoke(input);
		expect(result).toBe(input);
		expect(logger.error).toHaveBeenCalledWith(
			'Failed to apply email i18n translations:',
			expect.any(Error),
		);
	});

	it('uses empty string for EMAIL_FROM when env var is missing', async () => {
		const logger = { error: vi.fn() };
		const getSchema = vi.fn().mockResolvedValue({});
		let cb: ((input: EmailOptions) => Promise<EmailOptions>) | undefined;
		const filter2 = vi.fn((_e: string, c: typeof cb) => {
			cb = c;
		});
		hook(
			{ filter: filter2 } as any,
			{ services: {} as any, logger, getSchema, env: {} } as any,
		);
		const locale = { 'password-reset': { subject: 'S', from_name: 'N' } };
		const trans = { subject: 'S', from_name: 'N' };
		mockResolveLocale.mockResolvedValue(locale);
		mockExtractTemplateTrans.mockReturnValue(trans);
		mockExtractRecipientEmail.mockReturnValue('u@example.com');
		await cb!(makeEmail('password-reset'));
		expect(mockApplyTranslations).toHaveBeenCalledWith(expect.anything(), trans, '');
	});
});
