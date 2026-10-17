/**
 * Deterministic IDs for seeded / filter-created rows.
 *
 * Seeded rows are created independently in every environment, so with
 * random UUIDs a local seed and a prod seed get different primary keys.
 * `directus-extension-schema-sync` matches rows by primary key (unless a
 * collection sets `getKey`), so deterministic IDs let both environments
 * converge on the same rows with no ID remapping.
 *
 * The namespace below was generated randomly once and MUST NEVER CHANGE —
 * bumping it would re-key every deterministic row and re-introduce the
 * collisions this exists to prevent.
 */
import { createHash } from 'node:crypto';

const NAMESPACE = '351d83e2-5be9-4482-a511-9c0287c42162';

function parseUuid(uuid: string): Buffer {
	const hex = uuid.replace(/-/g, '');
	return Buffer.from(hex, 'hex');
}

function formatUuid(bytes: Buffer): string {
	const hex = bytes.toString('hex');
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20, 32),
	].join('-');
}

/**
 * RFC 4122 §4.3 name-based UUID (SHA-1). Same name + namespace always
 * yields the same UUID.
 */
export function uuidv5(name: string, namespace: string = NAMESPACE): string {
	const hash = createHash('sha1')
		.update(parseUuid(namespace))
		.update(Buffer.from(name, 'utf-8'))
		.digest();
	const bytes = Buffer.from(hash.subarray(0, 16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	return formatUuid(bytes);
}

/** Deterministic ID for an `email_templates` row. */
export function templateId(templateKey: string): string {
	return uuidv5(`template:${templateKey}`);
}

/** Deterministic ID for an `email_template_translations` row. */
export function translationId(templateId: string, lang: string): string {
	return uuidv5(`translation:${templateId}:${lang}`);
}

/** Deterministic ID for an `email_template_variables` row. */
export function variableId(templateKey: string, variableName: string): string {
	return uuidv5(`variable:${templateKey}:${variableName}`);
}
