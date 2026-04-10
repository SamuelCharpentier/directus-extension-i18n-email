import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveLocale, extractTemplateTrans } from '../src/locale';
import type { LocaleData } from '../src/types';

vi.mock('node:fs/promises', () => ({
	readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
const mockReadFile = vi.mocked(readFile);

const FR_LOCALE: LocaleData = {
	from_name: 'Sympo de Thetford',
	'password-reset': {
		subject: 'Demande de réinitialisation',
		cta: 'Réinitialiser mon mot de passe',
	},
};

const EN_LOCALE: LocaleData = {
	from_name: 'Sympo of Thetford',
	'password-reset': {
		subject: 'Password Reset Request',
		cta: 'Reset Your Password',
	},
};

describe('resolveLocale', () => {
	beforeEach(() => {
		mockReadFile.mockReset();
	});

	it('returns null when templatesPath is empty', async () => {
		const result = await resolveLocale('', 'fr', 'en');
		expect(result).toBeNull();
	});

	it('returns the user lang locale when it exists', async () => {
		mockReadFile.mockResolvedValueOnce(JSON.stringify(FR_LOCALE) as any);

		const result = await resolveLocale('/templates', 'fr', 'en');

		expect(result).toEqual(FR_LOCALE);
		expect(mockReadFile).toHaveBeenCalledOnce();
		expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('fr.json'), 'utf-8');
	});

	it('falls back to the default lang locale when user lang file is missing', async () => {
		mockReadFile
			.mockRejectedValueOnce(new Error('ENOENT'))
			.mockResolvedValueOnce(JSON.stringify(EN_LOCALE) as any);

		const result = await resolveLocale('/templates', 'de', 'en');

		expect(result).toEqual(EN_LOCALE);
		expect(mockReadFile).toHaveBeenCalledTimes(2);
		expect(mockReadFile).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining('de.json'),
			'utf-8',
		);
		expect(mockReadFile).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('en.json'),
			'utf-8',
		);
	});

	it('returns null when both user lang and default lang files are missing', async () => {
		mockReadFile.mockRejectedValue(new Error('ENOENT'));

		const result = await resolveLocale('/templates', 'de', 'en');

		expect(result).toBeNull();
	});

	it('does not read the default lang file when user lang matches and file exists', async () => {
		mockReadFile.mockResolvedValueOnce(JSON.stringify(FR_LOCALE) as any);

		await resolveLocale('/templates', 'fr', 'fr');

		expect(mockReadFile).toHaveBeenCalledOnce();
	});
});

describe('extractTemplateTrans', () => {
	it('returns the template section when it exists', () => {
		const result = extractTemplateTrans(FR_LOCALE, 'password-reset');

		expect(result).not.toBeNull();
		expect(result!.subject).toBe('Demande de réinitialisation');
	});

	it('returns null when the template section does not exist', () => {
		const result = extractTemplateTrans(FR_LOCALE, 'user-invitation');

		expect(result).toBeNull();
	});

	it('inherits top-level from_name when the template section has none', () => {
		const result = extractTemplateTrans(FR_LOCALE, 'password-reset');

		expect(result!.from_name).toBe('Sympo de Thetford');
	});

	it('uses a per-template from_name over the top-level one when both are set', () => {
		const locale: LocaleData = {
			from_name: 'Top Level Name',
			'password-reset': {
				subject: 'Reset',
				from_name: 'Template Specific Name',
			},
		};

		const result = extractTemplateTrans(locale, 'password-reset');

		expect(result!.from_name).toBe('Template Specific Name');
	});

	it('returns null when the template key is a string instead of an object', () => {
		const locale: LocaleData = {
			from_name: 'Sympo de Thetford',
		};

		const result = extractTemplateTrans(locale, 'from_name');

		expect(result).toBeNull();
	});

	it('does not inject from_name when locale.from_name is not a string', () => {
		const locale: LocaleData = {
			'password-reset': { subject: 'Reset' },
		};

		const result = extractTemplateTrans(locale, 'password-reset');

		expect(result!.from_name).toBeUndefined();
	});
});
