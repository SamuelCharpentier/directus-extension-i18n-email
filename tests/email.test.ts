import { describe, it, expect } from 'vitest';
import type { EmailOptions } from '@directus/types';
import { applyTranslationsToEmail, extractRecipientEmail } from '../src/email';

describe('extractRecipientEmail', () => {
	it('returns a plain string', () => {
		expect(extractRecipientEmail('a@b.com')).toBe('a@b.com');
	});

	it('handles an array of strings', () => {
		expect(extractRecipientEmail(['a@b.com', 'c@d.com'] as any)).toBe('a@b.com');
	});

	it('handles an array of address objects', () => {
		expect(extractRecipientEmail([{ address: 'x@y.com' }] as any)).toBe('x@y.com');
	});

	it('handles a single address object', () => {
		expect(extractRecipientEmail({ address: 'x@y.com' } as any)).toBe('x@y.com');
	});

	it('returns null when the address object has no address property', () => {
		expect(extractRecipientEmail({} as any)).toBe(null);
		expect(extractRecipientEmail([{}] as any)).toBe(null);
	});

	it('returns null for falsy inputs', () => {
		expect(extractRecipientEmail(null as any)).toBe(null);
	});
});

describe('applyTranslationsToEmail', () => {
	function baseEmail(): EmailOptions {
		return {
			to: 'x@y.com',
			subject: 'Original',
			template: { name: 't', data: { url: 'https://ex.com' } },
		} as EmailOptions;
	}

	it('sets subject, from, and i18n from translations (bare env address)', () => {
		const email = baseEmail();
		applyTranslationsToEmail(
			email,
			{ subject: 'Bonjour', from_name: 'Org', heading: 'H', body: 'B' },
			'noreply@ex.com',
		);
		expect(email.subject).toBe('Bonjour');
		expect((email as any).from).toEqual({ name: 'Org', address: 'noreply@ex.com' });
		expect(email.template?.data).toEqual({
			url: 'https://ex.com',
			i18n: { heading: 'H', body: 'B' },
		});
	});

	it('extracts the bare address from a RFC-5322 display-form EMAIL_FROM', () => {
		const email = baseEmail();
		applyTranslationsToEmail(
			email,
			{ subject: 'Hi', from_name: 'Org', heading: 'H' },
			'Previous <noreply@ex.com>',
		);
		expect((email as any).from).toEqual({ name: 'Org', address: 'noreply@ex.com' });
	});

	it('leaves subject and from untouched when translations omit them', () => {
		const email = baseEmail();
		applyTranslationsToEmail(email, { heading: 'H' }, 'noreply@ex.com');
		expect(email.subject).toBe('Original');
		expect((email as any).from).toBeUndefined();
		expect(email.template?.data).toEqual({ url: 'https://ex.com', i18n: { heading: 'H' } });
	});

	it('skips i18n injection when the email has no template', () => {
		const email = { to: 'x@y.com', subject: 's' } as EmailOptions;
		applyTranslationsToEmail(email, { subject: 'New', heading: 'H' }, '');
		expect(email.subject).toBe('New');
		expect((email as any).template).toBeUndefined();
	});
});
