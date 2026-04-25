import { describe, it, expect } from 'vitest';
import { extractRecipientEmail, applyTranslationsToEmail } from '../src/email';

describe('extractRecipientEmail', () => {
	it('handles strings', () => {
		expect(extractRecipientEmail('a@b.co')).toBe('a@b.co');
	});
	it('handles arrays of strings', () => {
		expect(extractRecipientEmail(['a@b.co', 'c@d.co'])).toBe('a@b.co');
	});
	it('handles arrays of address objects', () => {
		expect(extractRecipientEmail([{ address: 'x@y.co' } as any])).toBe('x@y.co');
	});
	it('handles single address object', () => {
		expect(extractRecipientEmail({ address: 'z@w.co' } as any)).toBe('z@w.co');
	});
	it('returns null for empty array', () => {
		expect(extractRecipientEmail([] as any)).toBe(null);
	});
	it('returns null when no address', () => {
		expect(extractRecipientEmail({} as any)).toBe(null);
	});
});

describe('applyTranslationsToEmail', () => {
	const base = () =>
		({
			to: 'a@b.co',
			subject: 'original',
			template: { name: 'password-reset', data: { url: 'https://x' } },
		}) as any;

	it('applies subject, from, i18n, base strings', () => {
		const email = base();
		applyTranslationsToEmail(email, {
			translation: {
				email_templates_id: 'x',
				languages_code: 'fr',
				subject: 'Bonjour',
				from_name: 'Mon Org',
				strings: { heading: 'Salut' },
			},
			baseStrings: { footer_note: 'au revoir' },
			fallbackFromName: null,
			fromEnv: '"Default" <no-reply@test.co>',
			recipientUser: null,
		});
		expect(email.subject).toBe('Bonjour');
		expect(email.from).toEqual({ name: 'Mon Org', address: 'no-reply@test.co' });
		expect(email.template.data.i18n).toEqual({
			heading: 'Salut',
			base: { footer_note: 'au revoir' },
		});
	});

	it('uses fallbackFromName when translation has no from_name', () => {
		const email = base();
		applyTranslationsToEmail(email, {
			translation: {
				email_templates_id: 'x',
				languages_code: 'en',
				subject: 'Hi',
				from_name: null,
				strings: {},
			},
			baseStrings: null,
			fallbackFromName: 'Fallback',
			fromEnv: 'raw@x.co',
			recipientUser: null,
		});
		expect(email.from).toEqual({ name: 'Fallback', address: 'raw@x.co' });
	});

	it('omits subject override when translation has empty subject', () => {
		const email = base();
		applyTranslationsToEmail(email, {
			translation: {
				email_templates_id: 'x',
				languages_code: 'en',
				subject: '',
				from_name: null,
				strings: { a: 'b' },
			},
			baseStrings: null,
			fallbackFromName: null,
			fromEnv: '',
			recipientUser: null,
		});
		expect(email.subject).toBe('original');
		expect(email.template.data.i18n).toEqual({ a: 'b' });
	});

	it('injects recipientUser into template.data', () => {
		const email = base();
		applyTranslationsToEmail(email, {
			translation: null,
			baseStrings: null,
			fallbackFromName: null,
			fromEnv: '',
			recipientUser: {
				id: '1',
				first_name: 'A',
				last_name: 'B',
				email: 'a@b.co',
				language: 'en',
			},
		});
		expect(email.template.data.user).toEqual({
			id: '1',
			first_name: 'A',
			last_name: 'B',
			email: 'a@b.co',
			language: 'en',
		});
	});

	it('is a no-op when email has no template', () => {
		const email: any = { to: 'a@b.co', subject: 's' };
		applyTranslationsToEmail(email, {
			translation: null,
			baseStrings: null,
			fallbackFromName: null,
			fromEnv: '',
			recipientUser: null,
		});
		expect(email.template).toBeUndefined();
	});

	it('handles template with undefined data', () => {
		const email: any = { to: 'a@b.co', template: { name: 'x' } };
		applyTranslationsToEmail(email, {
			translation: {
				email_templates_id: 'x',
				languages_code: 'en',
				subject: 'Sub',
				from_name: null,
				strings: { k: 'v' },
			},
			baseStrings: null,
			fallbackFromName: null,
			fromEnv: '',
			recipientUser: null,
		});
		expect(email.template.data.i18n).toEqual({ k: 'v' });
	});
});
