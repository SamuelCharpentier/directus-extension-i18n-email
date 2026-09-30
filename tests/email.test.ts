import { describe, it, expect } from 'vitest';
import { extractRecipientEmail, applyTranslationsToEmail } from '../src/email';
import { makeLogger } from './helpers';

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

	const mkTranslation = (overrides: any = {}) => ({
		email_templates_id: 'x',
		languages_code: 'en',
		subject: '',
		from_name: null,
		from_address: null,
		i18n_variables: {},
		...overrides,
	});

	it('applies subject, from, i18n, base strings', () => {
		const email = base();
		applyTranslationsToEmail(email, {
			translation: mkTranslation({
				languages_code: 'fr',
				subject: 'Bonjour',
				from_name: 'Mon Org',
				i18n_variables: { heading: 'Salut' },
			}),
			baseStrings: { footer_note: 'au revoir' },
			fallbackFromName: null,
			fromEnv: '"Default" <no-reply@test.co>',
			recipientUser: null,
			logger: makeLogger(),
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
			translation: mkTranslation({ subject: 'Hi' }),
			baseStrings: null,
			fallbackFromName: 'Fallback',
			fromEnv: 'raw@x.co',
			recipientUser: null,
			logger: makeLogger(),
		});
		expect(email.from).toEqual({ name: 'Fallback', address: 'raw@x.co' });
	});

	it('passes an explicit from object through untouched', () => {
		const email = base();
		email.from = { address: 'explicit@sender.co', name: 'Explicit Sender' };
		applyTranslationsToEmail(email, {
			translation: mkTranslation({ subject: 'Hi', from_name: 'Mon Org', from_address: 'fr@x.co' }),
			baseStrings: null,
			fallbackFromName: 'Fallback',
			fromEnv: '"Default" <no-reply@test.co>',
			recipientUser: null,
			logger: makeLogger(),
		});
		expect(email.from).toEqual({ address: 'explicit@sender.co', name: 'Explicit Sender' });
	});

	it('passes an explicit from string through untouched when no name source exists', () => {
		const email = base();
		email.from = 'caller@sender.co';
		applyTranslationsToEmail(email, {
			translation: mkTranslation({ subject: 'Hi' }),
			baseStrings: null,
			fallbackFromName: null,
			fromEnv: 'no-reply@test.co',
			recipientUser: null,
			logger: makeLogger(),
		});
		expect(email.from).toBe('caller@sender.co');
	});

	it('enriches an explicit from string with a display name when one is resolvable', () => {
		const email = base();
		email.from = 'caller@sender.co';
		applyTranslationsToEmail(email, {
			translation: mkTranslation({ subject: 'Hi', from_name: 'Mon Org' }),
			baseStrings: null,
			fallbackFromName: 'Fallback',
			fromEnv: 'no-reply@test.co',
			recipientUser: null,
			logger: makeLogger(),
		});
		expect(email.from).toEqual({ name: 'Mon Org', address: 'caller@sender.co' });
	});

	it('enriches an explicit from string with the fallback name when translation has none', () => {
		const email = base();
		email.from = 'caller@sender.co';
		applyTranslationsToEmail(email, {
			translation: mkTranslation({ subject: 'Hi' }),
			baseStrings: null,
			fallbackFromName: 'Fallback',
			fromEnv: 'no-reply@test.co',
			recipientUser: null,
			logger: makeLogger(),
		});
		expect(email.from).toEqual({ name: 'Fallback', address: 'caller@sender.co' });
	});

	it('leaves a formatted from string untouched instead of re-keying it', () => {
		const email = base();
		email.from = '"Caller Name" <caller@sender.co>';
		applyTranslationsToEmail(email, {
			translation: mkTranslation({ subject: 'Hi', from_name: 'Mon Org' }),
			baseStrings: null,
			fallbackFromName: null,
			fromEnv: 'no-reply@test.co',
			recipientUser: null,
			logger: makeLogger(),
		});
		expect(email.from).toBe('"Caller Name" <caller@sender.co>');
	});

	it('applies translation from_name and from_address when from is absent', () => {
		const email = base();
		applyTranslationsToEmail(email, {
			translation: mkTranslation({
				subject: 'Bonjour',
				from_name: 'Mon Org',
				from_address: 'sans-reponse@sympothetford.com',
			}),
			baseStrings: null,
			fallbackFromName: 'Fallback',
			fromEnv: 'no-reply@test.co',
			recipientUser: null,
			logger: makeLogger(),
		});
		expect(email.from).toEqual({
			name: 'Mon Org',
			address: 'sans-reponse@sympothetford.com',
		});
	});

	it('falls back to fallbackFromName + EMAIL_FROM when translation has no sender fields', () => {
		const email = base();
		applyTranslationsToEmail(email, {
			translation: mkTranslation({ subject: 'Hi' }),
			baseStrings: null,
			fallbackFromName: 'Fallback',
			fromEnv: 'raw@x.co',
			recipientUser: null,
			logger: makeLogger(),
		});
		expect(email.from).toEqual({ name: 'Fallback', address: 'raw@x.co' });
	});

	it('uses fallback name + EMAIL_FROM address when there is no translation', () => {
		const email = base();
		applyTranslationsToEmail(email, {
			translation: null,
			baseStrings: null,
			fallbackFromName: 'Fallback',
			fromEnv: 'raw@x.co',
			recipientUser: null,
			logger: makeLogger(),
		});
		expect(email.from).toEqual({ name: 'Fallback', address: 'raw@x.co' });
	});

	it('leaves from unset when EMAIL_FROM env is missing', () => {
		const email = base();
		applyTranslationsToEmail(email, {
			translation: mkTranslation({ subject: 'Hi', from_name: 'Mon Org' }),
			baseStrings: null,
			fallbackFromName: 'Fallback',
			fromEnv: '',
			recipientUser: null,
			logger: makeLogger(),
		});
		expect(email.from).toBeUndefined();
	});

	it('warns and falls back to EMAIL_FROM when translation from_address is not a valid email', () => {
		const logger = makeLogger();
		const email = base();
		applyTranslationsToEmail(email, {
			translation: mkTranslation({
				subject: 'Bonjour',
				from_name: 'Mon Org',
				from_address: 'pas une adresse',
			}),
			baseStrings: null,
			fallbackFromName: 'Fallback',
			fromEnv: 'no-reply@test.co',
			recipientUser: null,
			logger,
		});
		expect(email.from).toEqual({ name: 'Mon Org', address: 'no-reply@test.co' });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('is not a valid email address'),
		);
	});

	it('warns and leaves from unset when EMAIL_FROM does not resolve to a bare address', () => {
		const logger = makeLogger();
		const email = base();
		applyTranslationsToEmail(email, {
			translation: mkTranslation({ subject: 'Hi' }),
			baseStrings: null,
			fallbackFromName: 'Fallback',
			fromEnv: 'not-an-address',
			recipientUser: null,
			logger,
		});
		expect(email.from).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('did not resolve to a valid sender address'),
		);
	});

	it('omits subject override when translation has empty subject', () => {
		const email = base();
		applyTranslationsToEmail(email, {
			translation: mkTranslation({ i18n_variables: { a: 'b' } }),
			baseStrings: null,
			fallbackFromName: null,
			fromEnv: '',
			recipientUser: null,
			logger: makeLogger(),
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
			logger: makeLogger(),
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
			logger: makeLogger(),
		});
		expect(email.template).toBeUndefined();
	});

	it('handles template with undefined data', () => {
		const email: any = { to: 'a@b.co', template: { name: 'x' } };
		applyTranslationsToEmail(email, {
			translation: mkTranslation({ subject: 'Sub', i18n_variables: { k: 'v' } }),
			baseStrings: null,
			fallbackFromName: null,
			fromEnv: '',
			recipientUser: null,
			logger: makeLogger(),
		});
		expect(email.template.data.i18n).toEqual({ k: 'v' });
	});
});
