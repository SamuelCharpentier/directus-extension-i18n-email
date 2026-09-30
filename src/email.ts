import type { EmailOptions } from '@directus/types';
import type {
	EmailTemplateTranslationRow,
	Logger,
	RecipientUser,
	TranslationStrings,
} from './types';
import { coerceI18nVariables } from './reconcile';

const EMAIL_ADDRESS_PATTERN = /<([^>]+)>$/;

/**
 * A from-address we emit ourselves must be a clean bare addr-spec:
 * no display-name envelope form, no whitespace, no angle brackets.
 */
const BARE_ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+$/;

export function extractRecipientEmail(to: EmailOptions['to']): string | null {
	if (typeof to === 'string') return to;
	if (Array.isArray(to)) {
		const first = to[0];
		const address = typeof first === 'string' ? first : ((first as any)?.address ?? null);
		return address || null;
	}
	const address = (to as any)?.address ?? null;
	return address || null;
}

function extractAddressFromEnv(emailFrom: string): string {
	const match = EMAIL_ADDRESS_PATTERN.exec(emailFrom);
	return match ? match[1]! : emailFrom.trim();
}

export type ApplyTranslationInput = {
	translation: EmailTemplateTranslationRow | null;
	baseStrings: TranslationStrings | null;
	fallbackFromName: string | null;
	fromEnv: string;
	recipientUser: RecipientUser | null;
	logger: Pick<Logger, 'warn'>;
};

/**
 * Validate a candidate sender address for use inside a `{ address }`
 * object we are about to emit. Returns the trimmed address, or null
 * when it is not a clean bare addr-spec (whitespace, `<`/`>`, missing
 * `@`, …) — in which case the caller must fall back or leave `from`
 * unset rather than emit a malformed sender.
 */
function validateBareAddress(candidate: string): string | null {
	const trimmed = candidate.trim();
	return BARE_ADDRESS_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Resolve the from-address for an email that carries no explicit
 * sender, following the same fallback chain as `from_name`
 * (effective-language translation → default-language translation →
 * env/fallback, applied independently per field):
 *   1. `translation.from_address` — validated; an invalid value warns
 *      and falls through to EMAIL_FROM.
 *   2. `EMAIL_FROM` — the envelope form (`"Name" <addr>`) is stripped;
 *      the remainder must be a bare address.
 * Returns null when nothing usable resolves — Directus then falls back
 * to EMAIL_FROM on its own.
 */
function resolveFromAddress(
	translation: EmailTemplateTranslationRow | null,
	fromEnv: string,
	logger: Pick<Logger, 'warn'>,
): string | null {
	const fromTranslation = translation?.from_address;
	if (fromTranslation) {
		const address = validateBareAddress(fromTranslation);
		if (address) return address;
		logger.warn(
			`[i18n-email] Translation from_address "${fromTranslation}" is not a valid email address — falling back to EMAIL_FROM.`,
		);
	}
	if (!fromEnv) return null;
	const extracted = validateBareAddress(extractAddressFromEnv(fromEnv));
	if (!extracted) {
		logger.warn(
			`[i18n-email] EMAIL_FROM "${fromEnv}" did not resolve to a valid sender address — leaving from unset.`,
		);
	}
	return extracted;
}

/**
 * Mutate the outgoing EmailOptions with the resolved translation:
 *   - override subject if provided
 *   - resolve the sender when the caller did not provide one:
 *       name    = translation.from_name || fallbackFromName
 *       address = translation.from_address || extractAddressFromEnv(EMAIL_FROM)
 *     (an explicit `from` in the payload always wins: an
 *     `{ address, name }` object passes through untouched; a bare
 *     address string keeps its address and is only enriched with a
 *     display name when one is resolvable)
 *   - inject `i18n` + `i18n.base` into template.data
 *   - inject `user` into template.data when hydrated
 */
export function applyTranslationsToEmail(email: EmailOptions, input: ApplyTranslationInput): void {
	const { translation, baseStrings, fallbackFromName, fromEnv, recipientUser, logger } = input;
	const strings = coerceI18nVariables(translation?.i18n_variables ?? null).in_template;

	if (translation?.subject) {
		email.subject = translation.subject;
	}

	if (email.from == null) {
		const fromName = translation?.from_name || fallbackFromName;
		const fromAddress = resolveFromAddress(translation, fromEnv, logger);
		if (fromName && fromAddress) {
			// Cast: EmailOptions types `from` as string, but nodemailer accepts
			// the Address object form for proper RFC 5322 encoding.
			(email as any).from = { name: fromName, address: fromAddress };
		}
	} else if (typeof email.from === 'string') {
		// Bare address string from the caller: its address wins untouched;
		// i18n only adds a display name when one is resolvable. Formatted
		// `"Name <address>"` strings are not part of this pipeline — they
		// pass through as-is rather than being re-keyed.
		const fromName = translation?.from_name || fallbackFromName;
		if (fromName && BARE_ADDRESS_PATTERN.test(email.from)) {
			(email as any).from = { name: fromName, address: email.from };
		}
	}
	// A complete `{ address, name }` object reaches MailService untouched.

	if (!email.template) return;
	const existing = (email.template.data ?? {}) as Record<string, unknown>;
	const i18n: Record<string, unknown> = { ...strings };
	if (baseStrings) i18n['base'] = baseStrings;
	email.template.data = {
		...existing,
		i18n,
		...(recipientUser ? { user: recipientUser } : {}),
	};
}
