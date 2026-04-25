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
});
