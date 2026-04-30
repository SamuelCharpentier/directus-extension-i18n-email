import { describe, it, expect, vi } from 'vitest';
import { extractI18nKeys } from '../src/liquid';
import {
	reconcileTranslationStrings,
	buildInitialStrings,
	reconcileTranslationsForTemplate,
	fetchTemplateBodyById,
	coerceI18nVariables,
} from '../src/reconcile';
import { makeServices, makeLogger, makeSchema } from './helpers';

const mkLogger = () => ({ warn: vi.fn() });

describe('extractI18nKeys', () => {
	it('returns empty set for empty body', () => {
		const out = extractI18nKeys('', 'x', mkLogger());
		expect([...out]).toEqual([]);
	});

	it('extracts simple `{{ i18n.foo }}` references', () => {
		const out = extractI18nKeys('{{ i18n.heading }} {{ i18n.body }}', 'x', mkLogger());
		expect([...out].sort()).toEqual(['body', 'heading']);
	});

	it('extracts from filter args and conditionals', () => {
		const body = `{{ i18n.cta | default: 'x' }} {% if i18n.foo %}{{ i18n.bar }}{% endif %}`;
		const out = extractI18nKeys(body, 'x', mkLogger());
		expect([...out].sort()).toEqual(['bar', 'cta', 'foo']);
	});

	it('skips dynamic `i18n[var]` lookups', () => {
		const out = extractI18nKeys('{{ i18n[dyn] }} {{ i18n.ok }}', 'x', mkLogger());
		expect([...out]).toEqual(['ok']);
	});

	it('skips `i18n.base.*` paths in non-base templates', () => {
		const out = extractI18nKeys(
			'{{ i18n.heading }} {{ i18n.base.lang }}',
			'password-reset',
			mkLogger(),
		);
		expect([...out]).toEqual(['heading']);
	});

	it('extracts only `i18n.base.*` paths in the base template', () => {
		const out = extractI18nKeys(
			'<html lang="{{ i18n.base.lang | default: \'en\' }}">{{ i18n.base.footer_note }}</html>',
			'base',
			mkLogger(),
		);
		expect([...out].sort()).toEqual(['footer_note', 'lang']);
	});

	it('drops `i18n.foo` (no sub-key) on base template', () => {
		const out = extractI18nKeys('{{ i18n.heading }}', 'base', mkLogger());
		expect([...out]).toEqual([]);
	});

	it('drops bare `{{ i18n.base }}` (no sub-key under base) on base template', () => {
		const out = extractI18nKeys('{{ i18n.base }}', 'base', mkLogger());
		expect([...out]).toEqual([]);
	});

	it('drops bare `i18n` reference (no sub-key)', () => {
		const out = extractI18nKeys('{{ i18n }}', 'x', mkLogger());
		expect([...out]).toEqual([]);
	});

	it('warns and returns empty on parser error', () => {
		const logger = mkLogger();
		const out = extractI18nKeys('{% if foo %}', 'x', logger);
		expect([...out]).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Static analysis failed'));
	});

	it('handles `{% layout "base" %}` without trying to load partials', () => {
		const out = extractI18nKeys(
			`{% layout "base" %}{% block content %}{{ i18n.heading }}{% endblock %}`,
			'password-reset',
			mkLogger(),
		);
		expect([...out]).toEqual(['heading']);
	});

	it('joins nested string segments with `.`', () => {
		const out = extractI18nKeys('{{ i18n.section.label }}', 'x', mkLogger());
		expect([...out]).toEqual(['section.label']);
	});

	it('skips paths whose deeper segment is dynamic (`i18n.foo[bar]`)', () => {
		const out = extractI18nKeys(
			'{{ i18n.foo[bar] }} {{ i18n.section[idx].label }} {{ i18n.ok }}',
			'x',
			mkLogger(),
		);
		expect([...out]).toEqual(['ok']);
	});
});

describe('coerceI18nVariables', () => {
	it('returns empty shape for null/undefined', () => {
		expect(coerceI18nVariables(null)).toEqual({ in_template: {}, unused: {} });
		expect(coerceI18nVariables(undefined)).toEqual({ in_template: {}, unused: {} });
	});

	it('returns empty shape for empty string', () => {
		expect(coerceI18nVariables('')).toEqual({ in_template: {}, unused: {} });
		expect(coerceI18nVariables('   ')).toEqual({ in_template: {}, unused: {} });
	});

	it('parses JSON string of new shape', () => {
		const out = coerceI18nVariables('{"in_template":{"a":"A"},"unused":{"b":"B"}}');
		expect(out).toEqual({ in_template: { a: 'A' }, unused: { b: 'B' } });
	});

	it('parses JSON string of legacy bare shape (treats as in_template)', () => {
		const out = coerceI18nVariables('{"a":"A","b":"B"}');
		expect(out).toEqual({ in_template: { a: 'A', b: 'B' }, unused: {} });
	});

	it('passes through new shape', () => {
		const out = coerceI18nVariables({ in_template: { a: 'A' }, unused: { b: 'B' } });
		expect(out).toEqual({ in_template: { a: 'A' }, unused: { b: 'B' } });
	});

	it('promotes legacy bare object into in_template', () => {
		const out = coerceI18nVariables({ a: 'A', b: 'B' } as never);
		expect(out).toEqual({ in_template: { a: 'A', b: 'B' }, unused: {} });
	});

	it('returns empty for malformed JSON string', () => {
		expect(coerceI18nVariables('not json')).toEqual({ in_template: {}, unused: {} });
	});

	it('returns empty for arrays', () => {
		expect(coerceI18nVariables([1, 2, 3] as never)).toEqual({ in_template: {}, unused: {} });
	});

	it('coerces non-string flat values to strings', () => {
		const out = coerceI18nVariables({ in_template: { n: 5, b: true, x: null } as never });
		expect(out.in_template).toEqual({ n: '5', b: 'true', x: '' });
		expect(out.unused).toEqual({});
	});

	it('drops nested objects from flat sections', () => {
		const out = coerceI18nVariables({
			in_template: { ok: 'A', nested: { x: 'y' } } as never,
			unused: {},
		});
		expect(out.in_template).toEqual({ ok: 'A' });
	});

	it('parses inner string members as JSON-encoded flat maps', () => {
		const out = coerceI18nVariables({
			in_template: '{"a":"A","b":"B"}',
			unused: '{"c":"C"}',
		} as never);
		expect(out.in_template).toEqual({ a: 'A', b: 'B' });
		expect(out.unused).toEqual({ c: 'C' });
	});

	it('treats blank inner string members as empty maps', () => {
		const out = coerceI18nVariables({
			in_template: '   ',
			unused: '',
		} as never);
		expect(out).toEqual({ in_template: {}, unused: {} });
	});

	it('treats invalid-JSON inner string members as empty maps', () => {
		const out = coerceI18nVariables({
			in_template: 'not json',
			unused: '[1,2,3]',
		} as never);
		expect(out).toEqual({ in_template: {}, unused: {} });
	});

	it('treats non-object inner members (numbers, booleans) as empty maps', () => {
		const out = coerceI18nVariables({
			in_template: 42,
			unused: true,
		} as never);
		expect(out).toEqual({ in_template: {}, unused: {} });
	});
});

describe('reconcileTranslationStrings', () => {
	it('adds missing keys as empty', () => {
		const r = reconcileTranslationStrings({ in_template: {}, unused: {} }, new Set(['a', 'b']));
		expect(r.value.in_template).toEqual({ a: '', b: '' });
		expect(r.value.unused).toEqual({});
		expect(r.changed).toBe(true);
	});

	it('moves orphan keys to unused, preserving values', () => {
		const r = reconcileTranslationStrings(
			{ in_template: { a: 'A', orphan: 'O' }, unused: {} },
			new Set(['a']),
		);
		expect(r.value.in_template).toEqual({ a: 'A' });
		expect(r.value.unused).toEqual({ orphan: 'O' });
		expect(r.changed).toBe(true);
	});

	it('promotes unused keys back to in_template when re-referenced', () => {
		const r = reconcileTranslationStrings(
			{ in_template: { a: 'A' }, unused: { b: 'B-prev' } },
			new Set(['a', 'b']),
		);
		expect(r.value.in_template).toEqual({ a: 'A', b: 'B-prev' });
		expect(r.value.unused).toEqual({});
		expect(r.changed).toBe(true);
	});

	it('is idempotent', () => {
		const used = new Set(['a', 'b']);
		const first = reconcileTranslationStrings(
			{ in_template: { a: 'A' }, unused: { b: 'B' } },
			used,
		);
		const second = reconcileTranslationStrings(first.value, used);
		expect(second.value).toEqual(first.value);
		expect(second.changed).toBe(false);
	});

	it('reports no change when state already matches usage', () => {
		const r = reconcileTranslationStrings(
			{ in_template: { a: 'A' }, unused: {} },
			new Set(['a']),
		);
		expect(r.changed).toBe(false);
	});

	it('handles null current state', () => {
		const r = reconcileTranslationStrings(null, new Set(['a']));
		expect(r.value.in_template).toEqual({ a: '' });
		expect(r.value.unused).toEqual({});
		expect(r.changed).toBe(true);
	});

	it('handles undefined current state', () => {
		const r = reconcileTranslationStrings(undefined, new Set(['a']));
		expect(r.value.in_template).toEqual({ a: '' });
		expect(r.changed).toBe(true);
	});

	it('detects no-change when both maps are empty and no keys used', () => {
		const r = reconcileTranslationStrings({ in_template: {}, unused: {} }, new Set());
		expect(r.changed).toBe(false);
	});

	it('detects no-change when value matches usage exactly', () => {
		const r = reconcileTranslationStrings(
			{ in_template: { a: 'old' }, unused: {} },
			new Set(['a']),
		);
		expect(r.changed).toBe(false);
	});

	it('detects change when key sets differ but counts match', () => {
		const r = reconcileTranslationStrings(
			{ in_template: { a: '' }, unused: {} },
			new Set(['b']),
		);
		expect(r.value.in_template).toEqual({ b: '' });
		expect(r.value.unused).toEqual({ a: '' });
		expect(r.changed).toBe(true);
	});

	it('accepts legacy bare-key shape and treats it as in_template', () => {
		const r = reconcileTranslationStrings({ a: 'A', orphan: 'O' } as never, new Set(['a']));
		expect(r.value.in_template).toEqual({ a: 'A' });
		expect(r.value.unused).toEqual({ orphan: 'O' });
		expect(r.changed).toBe(true);
	});

	// Regression: ItemsService can return JSON columns as raw strings; the old
	// `{...currentValue}` spread char-soup'd them into 0/1/2-keyed garbage.
	it('parses JSON-string inputs without char-spread corruption', () => {
		const stored =
			'{"in_template":{"heading":"H","body":"","cta":"","expiry_notice":""},"unused":{}}';
		const r = reconcileTranslationStrings(
			stored,
			new Set(['heading', 'body', 'cta', 'expiry_notice_message']),
		);
		expect(r.value.in_template).toEqual({
			heading: 'H',
			body: '',
			cta: '',
			expiry_notice_message: '',
		});
		expect(r.value.unused).toEqual({ expiry_notice: '' });
		expect(Object.keys(r.value.unused).every((k) => /^[a-z_]/i.test(k))).toBe(true);
	});

	it('parses JSON-string of legacy bare shape', () => {
		const stored = '{"heading":"H","orphan":"O"}';
		const r = reconcileTranslationStrings(stored, new Set(['heading']));
		expect(r.value.in_template).toEqual({ heading: 'H' });
		expect(r.value.unused).toEqual({ orphan: 'O' });
	});

	it('treats malformed string inputs as empty maps', () => {
		const r = reconcileTranslationStrings('not json', new Set(['x']));
		expect(r.value.in_template).toEqual({ x: '' });
		expect(r.value.unused).toEqual({});
	});
});

describe('buildInitialStrings', () => {
	it('returns one empty in_template entry per referenced key, empty unused', () => {
		const out = buildInitialStrings('{{ i18n.a }} {{ i18n.b }}', 'x', mkLogger());
		expect(out).toEqual({ in_template: { a: '', b: '' }, unused: {} });
	});

	it('returns empty shape for body with no i18n usage', () => {
		const out = buildInitialStrings('{{ user.name }}', 'x', mkLogger());
		expect(out).toEqual({ in_template: {}, unused: {} });
	});
});

describe('reconcileTranslationsForTemplate', () => {
	it('updates only changed translation rows', async () => {
		const services = makeServices({
			items: {
				email_template_translations: {
					rows: [
						{
							id: 't1',
							email_templates_id: 'tpl-1',
							languages_code: 'en-US',
							i18n_variables: {
								in_template: { heading: 'Hi', orphan: 'old' },
								unused: {},
							},
						},
						{
							id: 't2',
							email_templates_id: 'tpl-1',
							languages_code: 'fr-FR',
							i18n_variables: { in_template: { heading: 'Salut' }, unused: {} },
						},
						{
							// noise: belongs to a different template, must be ignored
							id: 't3',
							email_templates_id: 'tpl-other',
							languages_code: 'en-US',
							i18n_variables: { in_template: {}, unused: {} },
						},
					],
				},
			},
		});
		const logger = makeLogger();
		const res = await reconcileTranslationsForTemplate(
			{ id: 'tpl-1', template_key: 'password-reset', body: '{{ i18n.heading }}' },
			services as any,
			makeSchema(),
			logger,
		);
		expect(res).toEqual({ scanned: 2, updated: 1 });
		const t1 = services._stores.email_template_translations!.find((r: any) => r.id === 't1');
		expect(t1.i18n_variables).toEqual({
			in_template: { heading: 'Hi' },
			unused: { orphan: 'old' },
		});
		const t2 = services._stores.email_template_translations!.find((r: any) => r.id === 't2');
		expect(t2.i18n_variables).toEqual({ in_template: { heading: 'Salut' }, unused: {} });
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Reconciled 1/2'));
	});

	it('warns and returns 0 when template id missing', async () => {
		const services = makeServices();
		const logger = makeLogger();
		const res = await reconcileTranslationsForTemplate(
			{ template_key: 'x', body: '' },
			services as any,
			makeSchema(),
			logger,
		);
		expect(res).toEqual({ scanned: 0, updated: 0 });
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing template id'));
	});

	it('warns and bails when readByQuery throws', async () => {
		const services = makeServices({
			items: {
				email_template_translations: {
					readByQuery: async () => {
						throw new Error('db down');
					},
				},
			},
		});
		const logger = makeLogger();
		const res = await reconcileTranslationsForTemplate(
			{ id: 'tpl-1', template_key: 'x', body: '' },
			services as any,
			makeSchema(),
			logger,
		);
		expect(res).toEqual({ scanned: 0, updated: 0 });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to read translation rows'),
		);
	});

	it('warns when updateOne throws but keeps scanning', async () => {
		const services = makeServices({
			items: {
				email_template_translations: {
					rows: [
						{
							id: 't1',
							email_templates_id: 'tpl-1',
							languages_code: 'en-US',
							i18n_variables: { in_template: { orphan: 'x' }, unused: {} },
						},
					],
					updateOne: async () => {
						throw new Error('write fail');
					},
				},
			},
		});
		const logger = makeLogger();
		const res = await reconcileTranslationsForTemplate(
			{ id: 'tpl-1', template_key: 'x', body: '{{ i18n.ok }}' },
			services as any,
			makeSchema(),
			logger,
		);
		expect(res).toEqual({ scanned: 1, updated: 0 });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to reconcile translation t1'),
		);
	});

	it('handles missing body via nullish coalesce', async () => {
		const services = makeServices({
			items: { email_template_translations: { rows: [] } },
		});
		const logger = makeLogger();
		const res = await reconcileTranslationsForTemplate(
			{ id: 'tpl-1', template_key: 'x' } as any,
			services as any,
			makeSchema(),
			logger,
		);
		expect(res).toEqual({ scanned: 0, updated: 0 });
	});
});

describe('fetchTemplateBodyById', () => {
	it('returns template_key + body when found', async () => {
		const services = makeServices({
			items: {
				email_templates: {
					rows: [{ id: 'tpl-1', template_key: 'k', body: 'B' }],
				},
			},
		});
		const out = await fetchTemplateBodyById(
			'tpl-1',
			services as any,
			makeSchema(),
			makeLogger(),
		);
		expect(out).toEqual({ template_key: 'k', body: 'B' });
	});

	it('coalesces null body to empty string', async () => {
		const services = makeServices({
			items: {
				email_templates: { rows: [{ id: 'tpl-1', template_key: 'k', body: null }] },
			},
		});
		const out = await fetchTemplateBodyById(
			'tpl-1',
			services as any,
			makeSchema(),
			makeLogger(),
		);
		expect(out).toEqual({ template_key: 'k', body: '' });
	});

	it('returns null when missing', async () => {
		const services = makeServices({
			items: { email_templates: { rows: [] } },
		});
		const out = await fetchTemplateBodyById(
			'tpl-1',
			services as any,
			makeSchema(),
			makeLogger(),
		);
		expect(out).toBeNull();
	});

	it('warns and returns null when readMany throws', async () => {
		const services = makeServices();
		const original = services.ItemsService;
		(services as any).ItemsService = (name: string, opts: any) => {
			const svc = original(name, opts);
			svc.readMany = async () => {
				throw new Error('boom');
			};
			return svc;
		};
		const logger = makeLogger();
		const out = await fetchTemplateBodyById('x', services as any, makeSchema(), logger);
		expect(out).toBeNull();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to load template'),
		);
	});
});
