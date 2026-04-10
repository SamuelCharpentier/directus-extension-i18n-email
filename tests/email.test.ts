import { describe, it, expect } from 'vitest';
import { extractRecipientEmail, applyTranslationsToEmail } from '../src/email';
import type { EmailOptions } from '@directus/types';
import type { TemplateTrans } from '../src/types';

describe('extractRecipientEmail', () => {
	it('returns a plain string address as-is', () => {
		expect(extractRecipientEmail('user@example.com')).toBe('user@example.com');
	});

	it('extracts address from the first element of an array of strings', () => {
		expect(extractRecipientEmail(['user@example.com', 'other@example.com'])).toBe(
			'user@example.com',
		);
	});

	it('extracts address from an address object', () => {
		expect(extractRecipientEmail({ address: 'user@example.com', name: 'User' } as any)).toBe(
			'user@example.com',
		);
	});

	it('extracts address from the first element of an array of address objects', () => {
		expect(
			extractRecipientEmail([
				{ address: 'user@example.com', name: 'User' } as any,
				'other@example.com',
			]),
		).toBe('user@example.com');
	});

	it('returns null when address is unavailable', () => {
		expect(extractRecipientEmail(undefined as any)).toBeNull();
	});

	it('returns null when array element has no address property', () => {
		expect(extractRecipientEmail([{} as any])).toBeNull();
	});
});

describe('applyTranslationsToEmail', () => {
	function makeEmail(overrides: Partial<EmailOptions> = {}): EmailOptions {
		return {
			to: 'user@example.com',
			subject: 'Original Subject',
			template: { name: 'password-reset', data: {} },
			...overrides,
		};
	}

	it('overrides the subject when trans.subject is set', () => {
		const email = makeEmail();
		const trans: TemplateTrans = { subject: 'Translated Subject' };

		applyTranslationsToEmail(email, trans, 'info@example.com');

		expect(email.subject).toBe('Translated Subject');
	});

	it('preserves the original subject when trans.subject is absent', () => {
		const email = makeEmail();
		const trans: TemplateTrans = { cta: 'Click here' };

		applyTranslationsToEmail(email, trans, 'info@example.com');

		expect(email.subject).toBe('Original Subject');
	});

	it('sets from with translated name and plain address from env', () => {
		const email = makeEmail();
		const trans: TemplateTrans = { from_name: 'Sympo de Thetford' };

		applyTranslationsToEmail(email, trans, 'info@example.com');

		expect(email.from).toBe('Sympo de Thetford <info@example.com>');
	});

	it('sets from with translated name and address extracted from a "Name <email>" env value', () => {
		const email = makeEmail();
		const trans: TemplateTrans = { from_name: 'Sympo de Thetford' };

		applyTranslationsToEmail(email, trans, 'Old Name <info@example.com>');

		expect(email.from).toBe('Sympo de Thetford <info@example.com>');
	});

	it('does not set from when from_name is absent', () => {
		const email = makeEmail({ from: 'original@example.com' });
		const trans: TemplateTrans = { subject: 'Hello' };

		applyTranslationsToEmail(email, trans, 'info@example.com');

		expect(email.from).toBe('original@example.com');
	});

	it('injects non-reserved keys into template.data.i18n', () => {
		const email = makeEmail({
			template: { name: 'password-reset', data: { existingVar: 'keep' } },
		});
		const trans: TemplateTrans = {
			subject: 'Subject',
			from_name: 'Name',
			heading: 'Reset your password',
			cta: 'Reset',
		};

		applyTranslationsToEmail(email, trans, 'info@example.com');

		expect(email.template!.data).toMatchObject({
			existingVar: 'keep',
			i18n: {
				heading: 'Reset your password',
				cta: 'Reset',
			},
		});
	});

	it('does not include subject or from_name in i18n template data', () => {
		const email = makeEmail();
		const trans: TemplateTrans = { subject: 'Subject', from_name: 'Name', cta: 'Go' };

		applyTranslationsToEmail(email, trans, 'info@example.com');

		expect(email.template!.data.i18n).not.toHaveProperty('subject');
		expect(email.template!.data.i18n).not.toHaveProperty('from_name');
	});

	it('excludes keys with non-string values from i18n template data', () => {
		const email = makeEmail();
		const trans: TemplateTrans = { cta: 'Click', broken: undefined };

		applyTranslationsToEmail(email, trans, 'info@example.com');

		expect(email.template!.data.i18n).toHaveProperty('cta', 'Click');
		expect(email.template!.data.i18n).not.toHaveProperty('broken');
	});

	it('does not modify template.data when email has no template', () => {
		const email: EmailOptions = { to: 'user@example.com', subject: 'Hi', html: '<p>Hi</p>' };
		const trans: TemplateTrans = { cta: 'Click' };

		applyTranslationsToEmail(email, trans, 'info@example.com');

		expect(email.template).toBeUndefined();
	});
});
