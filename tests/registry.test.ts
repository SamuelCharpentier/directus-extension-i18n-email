import { describe, it, expect, vi } from 'vitest';
import { emptySchema, makeServices } from './helpers';
import { hasLiquidDefault, validateRequiredVariables } from '../src/registry';

describe('hasLiquidDefault', () => {
	it('detects a default filter on the variable', () => {
		expect(hasLiquidDefault('hello {{ name | default: "there" }}', 'name')).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(hasLiquidDefault('{{ name | DEFAULT: "x" }}', 'name')).toBe(true);
	});

	it('escapes regex-special characters in the variable name', () => {
		expect(hasLiquidDefault('{{ user.name | default: "x" }}', 'user.name')).toBe(true);
		expect(hasLiquidDefault('{{ userXname }}', 'user.name')).toBe(false);
	});

	it('returns false when no default is present', () => {
		expect(hasLiquidDefault('{{ name }}', 'name')).toBe(false);
		expect(hasLiquidDefault('no placeholders', 'name')).toBe(false);
	});
});

describe('validateRequiredVariables', () => {
	const registryRows = [
		{
			template_key: 'k',
			variable_name: 'url',
			is_required: true,
			is_protected: false,
			description: null,
			example_value: null,
		},
		{
			template_key: 'k',
			variable_name: 'name',
			is_required: true,
			is_protected: false,
			description: null,
			example_value: null,
		},
		{
			template_key: 'k',
			variable_name: 'opt',
			is_required: false,
			is_protected: false,
			description: null,
			example_value: null,
		},
	];

	function setup(rows = registryRows) {
		return makeServices({
			items: {
				email_template_variables: { readByQuery: vi.fn().mockResolvedValue(rows) },
			},
		});
	}

	it('returns ok when all required variables are provided', async () => {
		const { services } = setup();
		expect(
			await validateRequiredVariables('k', { url: 'x', name: 'y' }, services, emptySchema),
		).toEqual({ ok: true });
	});

	it('returns ok with an empty registry', async () => {
		const { services } = setup([]);
		expect(await validateRequiredVariables('k', {}, services, emptySchema)).toEqual({
			ok: true,
		});
	});

	it('returns the list of missing required variables', async () => {
		const { services } = setup();
		const result = await validateRequiredVariables('k', { url: 'x' }, services, emptySchema);
		expect(result).toEqual({ ok: false, missing: ['name'] });
	});

	it('accepts a Liquid | default: guard as a substitute for data presence', async () => {
		const { services } = setup();
		const result = await validateRequiredVariables(
			'k',
			{ url: 'x' },
			services,
			emptySchema,
			'Hello {{ name | default: "there" }}',
		);
		expect(result).toEqual({ ok: true });
	});

	it('treats empty-string values as present', async () => {
		const { services } = setup();
		expect(
			await validateRequiredVariables('k', { url: '', name: '' }, services, emptySchema),
		).toEqual({ ok: true });
	});
});
