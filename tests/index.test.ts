import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import hook from '../src/index';
import { makeServices, makeLogger, makeSchema } from './helpers';
import { __INTERNAL__ } from '../src/bootstrap';

type AnyFn = (...args: any[]) => any;
type Handlers = {
	filters: Record<string, AnyFn>;
	actions: Record<string, AnyFn>;
	inits: Record<string, AnyFn>;
};

function register(
	env: Record<string, unknown> = {},
	opts: { getSchema?: () => Promise<any> } = {},
) {
	const handlers: Handlers = { filters: {}, actions: {}, inits: {} };
	const filter = (name: string, h: AnyFn) => {
		handlers.filters[name] = h;
	};
	const action = (name: string, h: AnyFn) => {
		handlers.actions[name] = h;
	};
	const init = (name: string, h: AnyFn) => {
		handlers.inits[name] = h;
	};
	const logger = makeLogger();
	const services = makeServices();
	const getSchema = opts.getSchema ?? (async () => makeSchema());
	(hook as any)(
		{ filter, action, init, schedule: vi.fn(), embed: vi.fn() },
		{ services, logger, getSchema, env },
	);
	return { handlers, logger, services, getSchema };
}

describe('hook registration', () => {
	let dir: string;
	beforeEach(async () => {
		__INTERNAL__.reset();
		dir = await mkdtemp(join(tmpdir(), 'i18n-email-hook-'));
	});
	afterEach(async () => {
		// Let the eager bootstrap settle so we can safely remove the tempdir.
		if (__INTERNAL__.inFlight) await __INTERNAL__.inFlight;
		await rm(dir, { recursive: true, force: true });
	});

	it('registers filters, actions and init event', () => {
		const { handlers } = register({ EMAIL_TEMPLATES_PATH: dir });
		expect(handlers.filters['email.send']).toBeTypeOf('function');
		expect(handlers.actions['server.start']).toBeTypeOf('function');
		expect(handlers.actions['email_templates.items.create']).toBeTypeOf('function');
		expect(handlers.actions['email_templates.items.update']).toBeTypeOf('function');
		expect(handlers.filters['email_templates.items.create']).toBeTypeOf('function');
		expect(handlers.filters['email_templates.items.update']).toBeTypeOf('function');
		expect(handlers.filters['email_templates.items.delete']).toBeTypeOf('function');
		expect(handlers.filters['email_template_translations.items.create']).toBeTypeOf('function');
		expect(handlers.filters['email_template_variables.items.delete']).toBeTypeOf('function');
		expect(handlers.inits['app.after']).toBeTypeOf('function');
	});

	it('checksum filter on create sets checksum', async () => {
		const { handlers } = register();
		const out = (await handlers.filters['email_templates.items.create']!({
			template_key: 'x',
			body: 'b',
		})) as any;
		expect(out.checksum).toMatch(/^[0-9a-f]{64}$/);
	});

	it('checksum filter on create handles missing body', async () => {
		const { handlers } = register();
		const out = (await handlers.filters['email_templates.items.create']!({
			template_key: 'x',
		})) as any;
		expect(out.checksum).toMatch(/^[0-9a-f]{64}$/);
	});

	it('checksum filter on update sets when body in patch', async () => {
		const { handlers } = register();
		const out = (await handlers.filters['email_templates.items.update']!({
			body: 'new',
		})) as any;
		expect(out.checksum).toMatch(/^[0-9a-f]{64}$/);
	});

	it('checksum filter on update hashes empty when body is undefined key', async () => {
		const { handlers } = register();
		const out = (await handlers.filters['email_templates.items.update']!({
			body: undefined,
		})) as any;
		expect(out.checksum).toMatch(/^[0-9a-f]{64}$/);
	});

	it('checksum filter on update leaves patch alone when body absent', async () => {
		const { handlers } = register();
		const out = (await handlers.filters['email_templates.items.update']!({
			description: 'd',
		})) as any;
		expect(out.checksum).toBeUndefined();
	});

	it('languages.items.create fills name from code via Intl.DisplayNames', async () => {
		const { handlers } = register();
		const out = (await handlers.filters['languages.items.create']!({
			code: 'fr-FR',
		})) as any;
		expect(out.code).toBe('fr-FR');
		expect(out.name).toBe('Français (France)');
	});

	it('languages.items.create skips when code missing or name already set', async () => {
		const { handlers } = register();
		const a = (await handlers.filters['languages.items.create']!({})) as any;
		expect(a.name).toBeUndefined();
		const b = (await handlers.filters['languages.items.create']!({
			code: 'en-US',
			name: 'preset',
		})) as any;
		expect(b.name).toBe('preset');
	});

	it('delete filter blocks protected template rows', async () => {
		const { handlers, services } = register();
		services._stores.email_templates = [{ id: '1', template_key: 'base', is_protected: true }];
		await expect(handlers.filters['email_templates.items.delete']!(['1'])).rejects.toThrow(
			/Cannot delete protected template/,
		);
	});

	it('delete filter allows unprotected template rows', async () => {
		const { handlers, services } = register();
		services._stores.email_templates = [
			{ id: '2', template_key: 'custom', is_protected: false },
		];
		const out = await handlers.filters['email_templates.items.delete']!(['2']);
		expect(out).toEqual(['2']);
	});

	it('delete filter is no-op on empty id list', async () => {
		const { handlers } = register();
		const out = await handlers.filters['email_templates.items.delete']!([]);
		expect(out).toEqual([]);
	});

	it('delete filter is no-op on undefined payload', async () => {
		const { handlers } = register();
		const out = await handlers.filters['email_templates.items.delete']!(undefined);
		expect(out).toBeUndefined();
	});

	it('variables delete filter is no-op on undefined payload', async () => {
		const { handlers } = register();
		const out = await handlers.filters['email_template_variables.items.delete']!(undefined);
		expect(out).toBeUndefined();
	});

	it('variables delete filter blocks protected variables', async () => {
		const { handlers, services } = register();
		services._stores.email_template_variables = [
			{ id: '1', template_key: 'password-reset', variable_name: 'url', is_protected: true },
		];
		await expect(
			handlers.filters['email_template_variables.items.delete']!(['1']),
		).rejects.toThrow(/protected variable/);
	});

	it('variables delete filter allows unprotected', async () => {
		const { handlers, services } = register();
		services._stores.email_template_variables = [
			{ id: '2', template_key: 'x', variable_name: 'y', is_protected: false },
		];
		const out = await handlers.filters['email_template_variables.items.delete']!(['2']);
		expect(out).toEqual(['2']);
	});

	it('variables delete filter no-op on empty', async () => {
		const { handlers } = register();
		expect(await handlers.filters['email_template_variables.items.delete']!([])).toEqual([]);
	});

	it('email.send filter proxies to runSendFilter', async () => {
		const { handlers } = register();
		const out = await handlers.filters['email.send']!({ to: 'a@b.co' });
		expect(out).toEqual({ to: 'a@b.co' });
	});

	it('create action syncs body to disk', async () => {
		const { handlers } = register({ EMAIL_TEMPLATES_PATH: dir });
		await handlers.actions['email_templates.items.create']!({
			key: 'id1',
			payload: { template_key: 'x', body: 'hello' },
		});

		const out = await readFile(join(dir, 'x.liquid'), 'utf-8');
		expect(out).toBe('hello');
	});

	it('create action no-op when payload missing', async () => {
		const { handlers, logger } = register({ EMAIL_TEMPLATES_PATH: dir });
		await handlers.actions['email_templates.items.create']!({});
		// no sync occurred => no info log with "Synced"
		expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Synced'));
	});

	it('create action logs error on failure', async () => {
		const { handlers, logger } = register(
			{ EMAIL_TEMPLATES_PATH: dir },
			{
				getSchema: async () => {
					throw new Error('schema-down');
				},
			},
		);
		await handlers.actions['email_templates.items.create']!({
			key: 'id1',
			payload: { template_key: 'x', body: 'hello' },
		});
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Post-create sync failed'),
		);
	});

	it('update action skips when body not in patch', async () => {
		const { handlers, services } = register({ EMAIL_TEMPLATES_PATH: dir });
		services._stores.email_templates = [{ id: '1', template_key: 'x', body: 'b' }];
		await handlers.actions['email_templates.items.update']!({
			keys: ['1'],
			payload: { description: 'd' },
		});
		// file should not exist — no sync path

		await expect(readFile(join(dir, 'x.liquid'), 'utf-8')).rejects.toThrow();
	});

	it('update action no-op when keys empty', async () => {
		const { handlers } = register({ EMAIL_TEMPLATES_PATH: dir });
		await handlers.actions['email_templates.items.update']!({
			keys: [],
			payload: { body: 'x' },
		});
	});

	it('update action resyncs body when body in patch', async () => {
		const { handlers, services } = register({ EMAIL_TEMPLATES_PATH: dir });
		services._stores.email_templates = [{ id: '1', template_key: 'x', body: 'new' }];
		await handlers.actions['email_templates.items.update']!({
			keys: ['1'],
			payload: { body: 'new' },
		});

		expect(await readFile(join(dir, 'x.liquid'), 'utf-8')).toBe('new');
	});

	it('update action logs error on failure', async () => {
		const { handlers, logger, services } = register({ EMAIL_TEMPLATES_PATH: dir });
		// override readMany to throw
		const original = services.ItemsService;
		(services as any).ItemsService = (name: string, opts: any) => {
			const svc = original(name, opts);
			svc.readMany = async () => {
				throw new Error('db down');
			};
			return svc;
		};
		await handlers.actions['email_templates.items.update']!({
			keys: ['1'],
			payload: { body: 'x' },
		});
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Post-update sync failed'),
		);
	});

	it('server.start action invokes bootstrap', async () => {
		const { handlers } = register({ EMAIL_TEMPLATES_PATH: dir });
		// The eager kick-off already started a bootstrap; reset so we can
		// observe a fresh run kicked by the server.start handler itself.
		if (__INTERNAL__.inFlight) await __INTERNAL__.inFlight;
		__INTERNAL__.reset();
		expect(__INTERNAL__.ran).toBe(false);
		handlers.actions['server.start']!();
		// kickBootstrap is fire-and-forget — the in-flight promise must
		// exist synchronously after the handler returns.
		expect(__INTERNAL__.inFlight).not.toBeNull();
		await __INTERNAL__.inFlight;
		expect(__INTERNAL__.ran).toBe(true);
	});

	it('app.after init handler invokes bootstrap', async () => {
		const { handlers } = register({ EMAIL_TEMPLATES_PATH: dir });
		// Drain the eager kick-off, then reset so we can observe the
		// app.after handler itself triggering a fresh runBootstrap.
		if (__INTERNAL__.inFlight) await __INTERNAL__.inFlight;
		__INTERNAL__.reset();
		expect(__INTERNAL__.ran).toBe(false);
		handlers.inits['app.after']!();
		expect(__INTERNAL__.inFlight).not.toBeNull();
		await __INTERNAL__.inFlight;
		expect(__INTERNAL__.ran).toBe(true);
	});

	it('create action falls back to row.id and empty body when key/body missing', async () => {
		// Exercises the falsy branches:
		//   id:   key ? String(key) : row.id   (no `key` in meta)
		//   body: row.body ?? ''                (no `body` on payload)
		const { handlers } = register({ EMAIL_TEMPLATES_PATH: dir });
		await handlers.actions['email_templates.items.create']!({
			payload: { id: 'row-id-7', template_key: 'no-key-no-body' },
		});
		// File still flushes with the empty body fallback.
		const out = await readFile(join(dir, 'no-key-no-body.liquid'), 'utf-8');
		expect(out).toBe('');
	});

	it('update action handles meta without keys array (?? [] fallback)', async () => {
		const { handlers, logger } = register({ EMAIL_TEMPLATES_PATH: dir });
		// meta has no `keys` field → falls back to [] → early return.
		await handlers.actions['email_templates.items.update']!({});
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('update action handles meta without payload object (?? {} fallback)', async () => {
		const { handlers, services } = register({ EMAIL_TEMPLATES_PATH: dir });
		services._stores.email_templates = [{ id: '1', template_key: 'p', body: 'pb' }];
		// keys present, no payload → patch defaults to {} → Object.keys(patch).length === 0,
		// so the body/template_key guard is skipped and readMany runs.
		await handlers.actions['email_templates.items.update']!({ keys: ['1'] });
		expect(await readFile(join(dir, 'p.liquid'), 'utf-8')).toBe('pb');
	});

	// ──────────── translation create filter (i18n var pre-fill) ────────────
	it('translations create filter pre-fills strings from parent body', async () => {
		const { handlers, services } = register({ EMAIL_TEMPLATES_PATH: dir });
		services._stores.email_templates = [
			{
				id: 'tpl-1',
				template_key: 'password-reset',
				body: '{{ i18n.heading }} {{ i18n.body }}',
			},
		];
		const out = (await handlers.filters['email_template_translations.items.create']!({
			email_templates_id: 'tpl-1',
			languages_code: 'en-US',
		})) as any;
		expect(out.i18n_variables).toEqual({ heading: '', body: '' });
		expect(out.unused_i18n_variables).toEqual({});
	});

	it('translations create filter preserves caller-supplied strings', async () => {
		const { handlers, services } = register({ EMAIL_TEMPLATES_PATH: dir });
		services._stores.email_templates = [
			{ id: 'tpl-1', template_key: 'p', body: '{{ i18n.heading }}' },
		];
		const out = (await handlers.filters['email_template_translations.items.create']!({
			email_templates_id: 'tpl-1',
			i18n_variables: { custom: 'value' },
		})) as any;
		expect(out.i18n_variables).toEqual({ custom: 'value' });
		expect(out.unused_i18n_variables).toEqual({});
	});

	it('translations create filter preserves caller-supplied unused_i18n_variables (both maps already set)', async () => {
		const { handlers, services } = register({ EMAIL_TEMPLATES_PATH: dir });
		services._stores.email_templates = [
			{ id: 'tpl-1', template_key: 'p', body: '{{ i18n.heading }}' },
		];
		const out = (await handlers.filters['email_template_translations.items.create']!({
			email_templates_id: 'tpl-1',
			i18n_variables: { custom: 'value' },
			unused_i18n_variables: { kept: 'k' },
		})) as any;
		expect(out.i18n_variables).toEqual({ custom: 'value' });
		expect(out.unused_i18n_variables).toEqual({ kept: 'k' });
	});

	it('translations create filter preserves caller-supplied unused_i18n_variables when strings empty', async () => {
		const { handlers, services } = register({ EMAIL_TEMPLATES_PATH: dir });
		services._stores.email_templates = [
			{ id: 'tpl-1', template_key: 'p', body: '{{ i18n.heading }}' },
		];
		const out = (await handlers.filters['email_template_translations.items.create']!({
			email_templates_id: 'tpl-1',
			unused_i18n_variables: { kept: 'k' },
		})) as any;
		expect(out.i18n_variables).toEqual({ heading: '' });
		expect(out.unused_i18n_variables).toEqual({ kept: 'k' });
	});

	it('translations create filter no-op when parent id missing', async () => {
		const { handlers } = register({ EMAIL_TEMPLATES_PATH: dir });
		const out = (await handlers.filters['email_template_translations.items.create']!({
			languages_code: 'en-US',
		})) as any;
		expect(out).toEqual({ languages_code: 'en-US' });
	});

	it('translations create filter falls back to empty maps when parent missing', async () => {
		const { handlers } = register({ EMAIL_TEMPLATES_PATH: dir });
		// no email_templates row exists for this id
		const out = (await handlers.filters['email_template_translations.items.create']!({
			email_templates_id: 'missing',
		})) as any;
		expect(out.i18n_variables).toEqual({});
		expect(out.unused_i18n_variables).toEqual({});
	});

	it('translations create filter warns when getSchema throws', async () => {
		const { handlers, logger } = register(
			{ EMAIL_TEMPLATES_PATH: dir },
			{
				getSchema: async () => {
					throw new Error('schema-down');
				},
			},
		);
		const out = (await handlers.filters['email_template_translations.items.create']!({
			email_templates_id: 'tpl-1',
		})) as any;
		expect(out.i18n_variables).toEqual({});
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Translation pre-fill skipped'),
		);
	});

	// ──────────── reconcile invocation in template create/update actions ────────────
	it('create action also reconciles existing translation rows', async () => {
		const { handlers, services } = register({ EMAIL_TEMPLATES_PATH: dir });
		// Pre-existing translation row attached to the template being created.
		services._stores.email_template_translations = [
			{
				id: 't1',
				email_templates_id: 'tpl-1',
				languages_code: 'en-US',
				i18n_variables: { stale: 'X' },
				unused_i18n_variables: {},
			},
		];
		await handlers.actions['email_templates.items.create']!({
			key: 'tpl-1',
			payload: { template_key: 'pr', body: '{{ i18n.heading }}' },
		});
		const t1 = services._stores.email_template_translations!.find((r: any) => r.id === 't1');
		expect(t1.i18n_variables).toEqual({ heading: '' });
		expect(t1.unused_i18n_variables).toEqual({ stale: 'X' });
	});

	it('update action reconciles when body changes', async () => {
		const { handlers, services } = register({ EMAIL_TEMPLATES_PATH: dir });
		services._stores.email_templates = [
			{ id: '1', template_key: 'pr', body: '{{ i18n.body }}' },
		];
		services._stores.email_template_translations = [
			{
				id: 't1',
				email_templates_id: '1',
				languages_code: 'en-US',
				i18n_variables: { heading: 'H', orphan: 'O' },
				unused_i18n_variables: {},
			},
		];
		await handlers.actions['email_templates.items.update']!({
			keys: ['1'],
			payload: { body: '{{ i18n.body }}' },
		});
		const t1 = services._stores.email_template_translations!.find((r: any) => r.id === 't1');
		expect(t1.i18n_variables).toEqual({ body: '' });
		expect(t1.unused_i18n_variables).toEqual({ heading: 'H', orphan: 'O' });
	});
});
