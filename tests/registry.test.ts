import { describe, it, expect } from 'vitest';
import { makeServices, makeSchema } from './helpers';
import { validateRequiredVariables } from '../src/registry';

describe('validateRequiredVariables', () => {
	const services = () =>
		makeServices({
			items: {
				email_template_variables: {
					rows: [
						{ template_key: 'x', variable_name: 'url', is_required: true },
						{ template_key: 'x', variable_name: 'optional', is_required: false },
					],
				},
			},
		});
	it('passes when required present', async () => {
		const r = await validateRequiredVariables(
			'x',
			{ url: 'https://a' },
			services() as any,
			makeSchema(),
		);
		expect(r).toEqual({ ok: true });
	});
	it('fails listing missing', async () => {
		const r = await validateRequiredVariables('x', {}, services() as any, makeSchema());
		expect(r.ok).toBe(false);
		expect(r.ok === false ? r.missing : []).toEqual(['url']);
	});
	it('passes when no required vars', async () => {
		const s = makeServices({ items: { email_template_variables: { rows: [] } } });
		const r = await validateRequiredVariables('anything', {}, s as any, makeSchema());
		expect(r).toEqual({ ok: true });
	});
});
