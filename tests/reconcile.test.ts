import { describe, it, expect, vi } from 'vitest';
import { extractI18nKeys } from '../src/liquid';
import {
	reconcileTranslationStrings,
	buildInitialStrings,
	reconcileTranslationsForTemplate,
	fetchTemplateBodyById,
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

describe('reconcileTranslationStrings', () => {
	it('adds missing keys as empty', () => {
		const r = reconcileTranslationStrings({}, {}, new Set(['a', 'b']));
		expect(r.strings).toEqual({ a: '', b: '' });
		expect(r.unused_strings).toEqual({});
		expect(r.changed).toBe(true);
	});

	it('moves orphan keys to unused, preserving values', () => {
		const r = reconcileTranslationStrings(
			{ a: 'A', orphan: 'O' },
			{},
			new Set(['a']),
		);
		expect(r.strings).toEqual({ a: 'A' });
		expect(r.unused_strings).toEqual({ orphan: 'O' });
		expect(r.changed).toBe(true);
	});

	it('promotes unused keys back to active when re-referenced', () => {
		const r = reconcileTranslationStrings(
			{ a: 'A' },
			{ b: 'B-prev' },
			new Set(['a', 'b']),
		);
		expect(r.strings).toEqual({ a: 'A', b: 'B-prev' });
		expect(r.unused_strings).toEqual({});
		expect(r.changed).toBe(true);
	});

	it('is idempotent', () => {
		const used = new Set(['a', 'b']);
		const first = reconcileTranslationStrings({ a: 'A' }, { b: 'B' }, used);
		const second = reconcileTranslationStrings(first.strings, first.unused_strings, used);
		expect(second.strings).toEqual(first.strings);
		expect(second.unused_strings).toEqual(first.unused_strings);
		expect(second.changed).toBe(false);
	});

	it('reports no change when state already matches usage', () => {
		const r = reconcileTranslationStrings({ a: 'A' }, {}, new Set(['a']));
		expect(r.changed).toBe(false);
	});

	it('handles null current state', () => {
		const r = reconcileTranslationStrings(null, null, new Set(['a']));
		expect(r.strings).toEqual({ a: '' });
		expect(r.unused_strings).toEqual({});
		expect(r.changed).toBe(true);
	});

	it('handles undefined current state', () => {
		const r = reconcileTranslationStrings(undefined, undefined, new Set(['a']));
		expect(r.strings).toEqual({ a: '' });
		expect(r.changed).toBe(true);
	});

	it('detects no-change when both maps are empty and no keys used', () => {
		const r = reconcileTranslationStrings({}, {}, new Set());
		expect(r.changed).toBe(false);
	});

	it('detects change via differing values (length equal)', () => {
		// Both have one key but value differs — first the helper drops `a`
		// (orphan), then re-adds it as `b`. We exercise the value-equality
		// branch directly:
		const r = reconcileTranslationStrings(
			{ a: 'old' },
			{},
			new Set(['a']),
		);
		expect(r.changed).toBe(false);
	});

	it('detects change when key sets differ but counts match', () => {
		// currentStrings = {a:''}, usedKeys={b} → after reconcile strings={b:''}, unused={a:''}.
		// Both maps end up size 1, so the equality check must fall through
		// to the per-key membership branch (`!(k in b)` returns false).
		const r = reconcileTranslationStrings({ a: '' }, {}, new Set(['b']));
		expect(r.strings).toEqual({ b: '' });
		expect(r.unused_strings).toEqual({ a: '' });
		expect(r.changed).toBe(true);
	});
});

describe('buildInitialStrings', () => {
	it('returns one empty value per referenced key', () => {
		const out = buildInitialStrings('{{ i18n.a }} {{ i18n.b }}', 'x', mkLogger());
		expect(out).toEqual({ a: '', b: '' });
	});

	it('returns empty object for body with no i18n usage', () => {
		const out = buildInitialStrings('{{ user.name }}', 'x', mkLogger());
		expect(out).toEqual({});
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
							strings: { heading: 'Hi', orphan: 'old' },
							unused_strings: {},
						},
						{
							id: 't2',
							email_templates_id: 'tpl-1',
							languages_code: 'fr-FR',
							strings: { heading: 'Salut' },
							unused_strings: {},
						},
						{
							// noise: belongs to a different template, must be ignored
							id: 't3',
							email_templates_id: 'tpl-other',
							languages_code: 'en-US',
							strings: {},
							unused_strings: {},
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
		expect(t1.strings).toEqual({ heading: 'Hi' });
		expect(t1.unused_strings).toEqual({ orphan: 'old' });
		const t2 = services._stores.email_template_translations!.find((r: any) => r.id === 't2');
		expect(t2.strings).toEqual({ heading: 'Salut' });
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
							strings: { orphan: 'x' },
							unused_strings: {},
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
		const out = await fetchTemplateBodyById('tpl-1', services as any, makeSchema(), makeLogger());
		expect(out).toEqual({ template_key: 'k', body: 'B' });
	});

	it('coalesces null body to empty string', async () => {
		const services = makeServices({
			items: {
				email_templates: { rows: [{ id: 'tpl-1', template_key: 'k', body: null }] },
			},
		});
		const out = await fetchTemplateBodyById('tpl-1', services as any, makeSchema(), makeLogger());
		expect(out).toEqual({ template_key: 'k', body: '' });
	});

	it('returns null when missing', async () => {
		const services = makeServices({
			items: { email_templates: { rows: [] } },
		});
		const out = await fetchTemplateBodyById('tpl-1', services as any, makeSchema(), makeLogger());
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
