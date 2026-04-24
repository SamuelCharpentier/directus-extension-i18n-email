import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMocks = vi.hoisted(() => ({
	writeFile: vi.fn().mockResolvedValue(undefined),
	rename: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('node:fs/promises', () => fsMocks);

import { emptySchema, makeLogger, makeServices } from './helpers';
import { runBootstrap, __INTERNAL__ } from '../src/bootstrap';
import { SEED_TEMPLATES, SEED_VARIABLES } from '../src/seeds';

function servicesWith(overrides: {
	collectionsExists?: boolean;
	existingTemplates?: any[];
	existingVariables?: any[];
}) {
	const { collectionsExists = false, existingTemplates = [], existingVariables = [] } = overrides;
	return makeServices({
		collections: {
			readOne: collectionsExists
				? vi.fn().mockResolvedValue({ collection: 'x' })
				: vi.fn().mockRejectedValue(new Error('missing')),
			createOne: vi.fn().mockResolvedValue('new'),
		},
		items: {
			email_templates: {
				readByQuery: vi.fn().mockResolvedValue(existingTemplates),
				createOne: vi.fn().mockResolvedValue('id'),
			},
			email_template_variables: {
				readByQuery: vi.fn().mockResolvedValue(existingVariables),
				createOne: vi.fn().mockResolvedValue('id'),
			},
		},
	});
}

describe('runBootstrap', () => {
	beforeEach(() => {
		__INTERNAL__.reset();
		fsMocks.writeFile.mockClear();
		fsMocks.rename.mockClear();
	});

	it('creates collections, seeds templates + variables, and syncs locales', async () => {
		const { services, collectionsInstance, itemsInstances } = servicesWith({
			collectionsExists: false,
		});
		const logger = makeLogger();
		const getSchema = vi.fn().mockResolvedValue(emptySchema);
		await runBootstrap('/tmp/tpl', services, getSchema, logger);
		expect(collectionsInstance.createOne).toHaveBeenCalledTimes(3);
		expect(itemsInstances['email_templates']!.createOne).toHaveBeenCalledTimes(
			SEED_TEMPLATES.length,
		);
		expect(itemsInstances['email_template_variables']!.createOne).toHaveBeenCalledTimes(
			SEED_VARIABLES.length,
		);
		expect(__INTERNAL__.ran).toBe(true);
	});

	it('skips collection creation when collections already exist', async () => {
		const { services, collectionsInstance } = servicesWith({ collectionsExists: true });
		await runBootstrap('', services, vi.fn().mockResolvedValue(emptySchema), makeLogger());
		expect(collectionsInstance.createOne).not.toHaveBeenCalled();
	});

	it('skips seeding rows that already exist', async () => {
		const { services, itemsInstances } = servicesWith({
			collectionsExists: true,
			existingTemplates: [{ id: '1' }],
			existingVariables: [{ id: '2' }],
		});
		await runBootstrap('', services, vi.fn().mockResolvedValue(emptySchema), makeLogger());
		expect(itemsInstances['email_templates']!.createOne).not.toHaveBeenCalled();
		expect(itemsInstances['email_template_variables']!.createOne).not.toHaveBeenCalled();
	});

	it('returns immediately when already run', async () => {
		const { services, collectionsInstance } = servicesWith({ collectionsExists: true });
		const logger = makeLogger();
		await runBootstrap('', services, vi.fn().mockResolvedValue(emptySchema), logger);
		collectionsInstance.readOne.mockClear();
		await runBootstrap('', services, vi.fn().mockResolvedValue(emptySchema), logger);
		expect(collectionsInstance.readOne).not.toHaveBeenCalled();
	});

	it('dedupes concurrent invocations via the in-flight lock', async () => {
		const { services, collectionsInstance } = servicesWith({ collectionsExists: true });
		const logger = makeLogger();
		const getSchema = vi.fn().mockResolvedValue(emptySchema);
		const [a, b] = await Promise.all([
			runBootstrap('', services, getSchema, logger),
			runBootstrap('', services, getSchema, logger),
		]);
		expect(a).toBe(b); // both resolved via the same promise
		// readOne only called once per collection (3 total) despite 2 invocations
		expect(collectionsInstance.readOne).toHaveBeenCalledTimes(3);
	});

	it('swallows errors and logs them (non-strict)', async () => {
		const services = makeServices({
			collections: {
				readOne: vi.fn().mockRejectedValue(new Error('x')),
				createOne: vi.fn().mockRejectedValue(new Error('perm denied')),
			},
		}).services;
		const logger = makeLogger();
		await runBootstrap('', services, vi.fn().mockResolvedValue(emptySchema), logger);
		expect(logger.error).toHaveBeenCalled();
		expect(__INTERNAL__.ran).toBe(false);
	});

	it('exposes collection name constants', () => {
		expect(__INTERNAL__.collections.TEMPLATES_COLLECTION).toBe('email_templates');
		expect(__INTERNAL__.collections.VARIABLES_COLLECTION).toBe('email_template_variables');
		expect(__INTERNAL__.collections.SYNC_AUDIT_COLLECTION).toBe('email_template_sync_audit');
	});
});
