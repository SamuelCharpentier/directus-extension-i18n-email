import { describe, it, expect } from 'vitest';
import { uuidv5, templateId, translationId, variableId } from '../src/ids';

describe('uuidv5', () => {
	it('matches the RFC 4122 known vector', () => {
		expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
			'2ed6657d-e927-568b-95e1-2665a8aea6a2',
		);
	});

	it('is deterministic for identical input', () => {
		expect(uuidv5('a')).toBe(uuidv5('a'));
	});

	it('differs for different input', () => {
		expect(uuidv5('a')).not.toBe(uuidv5('b'));
	});

	it('emits a version-5 UUID shape', () => {
		expect(uuidv5('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});
});

describe('deterministic ids', () => {
	it('is stable and distinct per collection namespace', () => {
		expect(templateId('base')).toBe(templateId('base'));
		expect(templateId('base')).not.toBe(templateId('password-reset'));
		expect(translationId('tpl', 'en-US')).not.toBe(translationId('tpl', 'fr-CA'));
		expect(variableId('base', 'org_name')).not.toBe(variableId('base', 'org_url'));
	});

	it('translation id depends on the template id', () => {
		expect(translationId(templateId('base'), 'en-US')).toBe(
			translationId(templateId('base'), 'en-US'),
		);
		expect(translationId(templateId('base'), 'en-US')).not.toBe(
			translationId(templateId('other'), 'en-US'),
		);
	});
});
