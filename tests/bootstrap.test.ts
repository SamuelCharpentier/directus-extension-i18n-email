import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServices, makeLogger, makeSchema } from './helpers';
import { runBootstrap, __INTERNAL__ } from '../src/bootstrap';

describe('runBootstrap', () => {
	let dir: string;
	beforeEach(async () => {
		__INTERNAL__.reset();
		dir = await mkdtemp(join(tmpdir(), 'i18n-email-boot-'));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const getSchema = async () => makeSchema();

	it('creates collections, relations, seeds, flushes bodies', async () => {
		const s = makeServices();
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		// collections
		expect(s._collectionsCreated.length).toBeGreaterThanOrEqual(5);
		// relations
		expect(s._relationsCreated.length).toBe(2);
		// language seeded — project default is en-US (no settings override),
		// so only one row is created.
		expect(s._stores.languages?.find((r: any) => r.code === 'en-US')).toBeTruthy();
		expect(s._stores.languages?.length).toBe(1);
		// templates seeded
		expect(s._stores.email_templates?.length).toBe(5);
		// translations seeded — one empty placeholder per template at the
		// project default lang (en-US). No English-suggested duplicate
		// because default IS en-US.
		expect(s._stores.email_template_translations?.length).toBe(5);
		// variables seeded
		expect(s._stores.email_template_variables?.length).toBeGreaterThan(0);
		// bodies flushed
		const body = await readFile(join(dir, 'base.liquid'), 'utf-8');
		expect(body).toContain('<html');
	});

	it('prefers disk body over seed default when row missing', async () => {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'base.liquid'), 'FROM_DISK', 'utf-8');
		const s = makeServices();
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		const baseRow = s._stores.email_templates?.find((r: any) => r.template_key === 'base');
		expect(baseRow.body).toBe('FROM_DISK');
	});

	it('does not overwrite existing DB row', async () => {
		const s = makeServices({
			items: {
				email_templates: {
					rows: [
						{
							id: 'pre',
							template_key: 'base',
							category: 'layout',
							body: 'EXISTING',
						},
					],
				},
			},
		});
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		const baseRow = s._stores.email_templates?.find((r: any) => r.template_key === 'base');
		expect(baseRow.body).toBe('EXISTING');
	});

	it('is idempotent on a second call', async () => {
		const s = makeServices();
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		const before = s._stores.email_templates?.length;
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		expect(s._stores.email_templates?.length).toBe(before);
	});

	it('concurrent calls coalesce', async () => {
		const s = makeServices();
		const logger = makeLogger();
		await Promise.all([
			runBootstrap(dir, s as any, getSchema, {}, logger),
			runBootstrap(dir, s as any, getSchema, {}, logger),
		]);
		expect(s._stores.email_templates?.length).toBe(5);
	});

	it('warns when RelationsService is missing', async () => {
		const s = makeServices();
		(s as any).RelationsService = undefined;
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('RelationsService not available'),
		);
	});

	it('skips relation when readOne finds existing', async () => {
		const s = makeServices({
			relations: {
				readOne: async (c: string, f: string) => ({
					collection: c,
					field: f,
					schema: { on_delete: 'CASCADE' },
				}),
			},
		});
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		expect(s._relationsCreated.length).toBe(0);
	});

	it('logs warning when relation creation fails', async () => {
		const s = makeServices({
			relations: {
				readOne: async () => {
					throw new Error('nope');
				},
				createOne: async () => {
					throw new Error('duplicate');
				},
			},
		});
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Relation create skipped'),
		);
	});

	it('skips collection creation when exists', async () => {
		const s = makeServices({
			collections: {
				readOne: async () => ({ collection: 'x' }),
			},
		});
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		expect(s._collectionsCreated.length).toBe(0);
	});

	it('skips translation seed when parent missing', async () => {
		const s = makeServices();
		const logger = makeLogger();
		const originalItemsService = (s as any).ItemsService;
		(s as any).ItemsService = function (name: string, opts: any) {
			const svc = originalItemsService(name, opts);
			if (name === 'email_templates') {
				svc.createOne = async () => undefined as any;
			}
			return svc;
		};
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('parent row missing'));
	});

	it('exposes inFlight getter while running and null after', async () => {
		const s = makeServices();
		const logger = makeLogger();
		const p = runBootstrap(dir, s as any, getSchema, {}, logger);
		expect(__INTERNAL__.inFlight).toBeInstanceOf(Promise);
		await p;
		expect(__INTERNAL__.inFlight).toBeNull();
		expect(__INTERNAL__.ran).toBe(true);
	});

	it('logs error and does not throw when bootstrap pipeline explodes', async () => {
		const s = makeServices({
			collections: {
				readOne: async () => {
					throw new Error('no coll');
				},
				createOne: async () => {
					throw new Error('boom');
				},
			},
		});
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Bootstrap failed'));
	});

	it('skips re-seeding languages when collection already has rows', async () => {
		// Simulates a second boot or admin-managed languages: the collection
		// is non-empty, so seedLanguages must NOT call createOne.
		const s = makeServices({
			items: {
				languages: {
					rows: [{ code: 'es-ES' }],
				},
			},
		});
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		// Still exactly the row we pre-seeded — no extras inserted.
		expect(s._stores.languages?.length).toBe(1);
		expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Seeded language'));
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('already populated'));
	});

	it('seeds project default + en-US when default differs from en-US', async () => {
		const s = makeServices({
			settings: { readSingleton: async () => ({ default_language: 'fr-FR' }) },
		});
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		const codes = s._stores.languages!.map((r: any) => r.code).sort();
		expect(codes).toEqual(['en-US', 'fr-FR']);
		// Each template gets two translation rows: empty fr-FR + suggested en-US.
		expect(s._stores.email_template_translations?.length).toBe(10);
		const frBaseRow = s._stores.email_template_translations!.find(
			(r: any) => r.languages_code === 'fr-FR',
		);
		expect(frBaseRow.subject).toBe('');
		expect(frBaseRow.i18n_variables).toEqual({});
		const enBaseRow = s._stores.email_template_translations!.find(
			(r: any) =>
				r.languages_code === 'en-US' &&
				r.email_templates_id === frBaseRow.email_templates_id,
		);
		expect(enBaseRow.from_name).toBe('Your Organization');
		expect(enBaseRow.i18n_variables.org_name).toBe('Your Organization');
	});

	it('skips re-seeding variables that already exist', async () => {
		// Pre-seed every SEED_VARIABLES row so the (template_key,
		// variable_name) lookup hits an existing record and createOne
		// is bypassed.
		const s = makeServices({
			items: {
				email_template_variables: {
					rows: [
						{ template_key: 'password-reset', variable_name: 'url' },
						{ template_key: 'user-invitation', variable_name: 'url' },
						{ template_key: 'user-registration', variable_name: 'url' },
						{ template_key: 'admin-error', variable_name: 'reason' },
						{ template_key: 'admin-error', variable_name: 'context' },
						{ template_key: 'admin-error', variable_name: 'timestamp' },
					],
				},
			},
		});
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		// No new variable rows added.
		expect(s._stores.email_template_variables?.length).toBe(6);
		expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Seeded variable'));
	});

	it('skips re-seeding translations that already exist', async () => {
		// Pre-seed a template row with a known id, plus a translation row
		// matching the en-US placeholder seedTranslations would otherwise
		// create. The (email_templates_id, languages_code) lookup must
		// hit the existing row — exercising the skip-when-exists continue
		// branch — instead of creating a duplicate.
		const s = makeServices({
			items: {
				email_templates: {
					rows: [{ id: 't-base', template_key: 'base' }],
				},
				email_template_translations: {
					rows: [
						{
							id: 'tr-base-en',
							email_templates_id: 't-base',
							languages_code: 'en-US',
							subject: '',
							from_name: 'pre-seeded',
							i18n_variables: { footer_note: 'pre-seeded' },
						},
					],
				},
			},
		});
		const logger = makeLogger();
		await runBootstrap(dir, s as any, getSchema, {}, logger);
		// The existing 'base/en-US' row must be untouched (still 1 row
		// with that pair) and no 'Seeded translation base/en-US' info
		// was logged.
		const baseEnRows = s._stores.email_template_translations!.filter(
			(r: any) => r.email_templates_id === 't-base' && r.languages_code === 'en-US',
		);
		expect(baseEnRows.length).toBe(1);
		expect(baseEnRows[0]!.from_name).toBe('pre-seeded');
		expect(logger.info).not.toHaveBeenCalledWith(
			expect.stringContaining('Seeded translation base/en-US'),
		);
		// Other templates still seed their en-US placeholder normally.
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining('Seeded translation password-reset/en-US'),
		);
	});

	describe('field migration', () => {
		it('upserts meta on existing fields without recreating them', async () => {
			const s = makeServices({
				collections: {
					readOne: async () => ({ collection: 'x' }),
				},
				fields: {
					readOne: async () => ({ field: 'translations' }),
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(s._fieldsCreated.length).toBe(0);
			expect(s._fieldsUpdated.length).toBeGreaterThan(0);
			const translationsUpdate = s._fieldsUpdated.find(
				(u: any) => u.collection === 'email_templates' && u.field.field === 'translations',
			);
			expect(translationsUpdate).toBeTruthy();
			expect(translationsUpdate.field.meta.options.languageField).toBe('name');
		});

		it('creates missing fields on existing collections', async () => {
			const s = makeServices({
				collections: {
					readOne: async () => ({ collection: 'x' }),
				},
				fields: {
					readOne: async () => {
						throw new Error('not found');
					},
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(s._fieldsCreated.length).toBeGreaterThan(0);
			const tField = s._fieldsCreated.find(
				(c: any) => c.collection === 'email_templates' && c.field.field === 'translations',
			);
			expect(tField).toBeTruthy();
		});

		it('warns when FieldsService is missing', async () => {
			const s = makeServices({
				collections: { readOne: async () => ({ collection: 'x' }) },
			});
			(s as any).FieldsService = undefined;
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('FieldsService not available'),
			);
		});

		it('logs and continues when field migration throws per-field', async () => {
			const s = makeServices({
				collections: { readOne: async () => ({ collection: 'x' }) },
				fields: {
					readOne: async () => ({ field: 'x' }),
					updateField: async () => {
						throw new Error('nope');
					},
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Field migrate skipped'),
			);
		});

		it('warns when an alias field exists as a real DB column', async () => {
			// Legacy schema: an older extension version registered
			// `translations` as a real text column. Don't try to alter the
			// column — surface a clear operator warning and move on.
			const s = makeServices({
				collections: { readOne: async () => ({ collection: 'x' }) },
				fields: {
					readOne: async (_c: string, f: string) =>
						f === 'translations'
							? { field: 'translations', type: 'text' }
							: { field: f, type: 'string' },
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining(
					'email_templates.translations is declared as alias but a real "text" column exists',
				),
			);
			// updateField MUST NOT fire for the conflicting alias field.
			const aliasUpdate = s._fieldsUpdated.find((u: any) => u.field.field === 'translations');
			expect(aliasUpdate).toBeUndefined();
		});
	});

	describe('relation migration', () => {
		// Healthy existing relation: schema includes the expected on_delete
		// AND meta is intentionally drifted (empty object) so the
		// metaMatches short-circuit lets the updateOne path fire.
		const healthyReadOne = async (c: string, f: string) => ({
			collection: c,
			field: f,
			schema: { on_delete: 'CASCADE' },
			meta: {},
		});

		it('upserts meta on existing relations with junction_field cross-refs', async () => {
			const s = makeServices({
				relations: { readOne: healthyReadOne },
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(s._relationsCreated.length).toBe(0);
			expect(s._relationsUpdated.length).toBe(2);
			const fwd = s._relationsUpdated.find((u: any) => u.field === 'email_templates_id');
			expect(fwd).toBeTruthy();
			expect(fwd.data.collection).toBe('email_template_translations');
			expect(fwd.data.related_collection).toBe('email_templates');
			expect(fwd.data.meta.junction_field).toBe('languages_code');
			const rev = s._relationsUpdated.find((u: any) => u.field === 'languages_code');
			expect(rev).toBeTruthy();
			expect(rev.data.related_collection).toBe('languages');
			expect(rev.data.meta.junction_field).toBe('email_templates_id');
		});

		it('skips updateOne when existing relation meta already matches', async () => {
			// Meta already carries the expected cross-refs → no need to
			// touch the FK; updateOne MUST NOT be called (avoids triggering
			// Directus's alterType crash on a steady-state boot).
			const s = makeServices({
				relations: {
					readOne: async (c: string, f: string) => ({
						collection: c,
						field: f,
						schema: { on_delete: 'CASCADE' },
						meta:
							f === 'email_templates_id'
								? {
										one_field: 'translations',
										junction_field: 'languages_code',
										sort_field: null,
										one_deselect_action: 'delete',
									}
								: {
										junction_field: 'email_templates_id',
										sort_field: null,
									},
					}),
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(s._relationsUpdated.length).toBe(0);
			expect(s._relationsCreated.length).toBe(0);
		});

		it('skips migration for relations that do not yet exist', async () => {
			const s = makeServices();
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			// fresh bootstrap: relations were just created, so no migration updates
			expect(s._relationsUpdated.length).toBe(0);
		});

		it('logs and continues when relation migration throws per-relation', async () => {
			const s = makeServices({
				relations: {
					readOne: healthyReadOne,
					updateOne: async () => {
						throw new Error('nope');
					},
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Relation migrate skipped'),
			);
		});

		it('warns when RelationsService.updateOne is unavailable', async () => {
			const s = makeServices({
				relations: { readOne: healthyReadOne },
			});
			const originalRelations = (s as any).RelationsService;
			(s as any).RelationsService = function (opts: any) {
				const inst = originalRelations(opts);
				delete inst.updateOne;
				return inst;
			};
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('updateOne not available'),
			);
		});

		it('rebuilds relations whose DB foreign key was never installed', async () => {
			// Stale directus_relations row with no FK schema: warn the
			// operator instead of attempting a brittle delete+recreate.
			const s = makeServices({
				relations: {
					readOne: async (c: string, f: string) => ({
						collection: c,
						field: f,
						schema: null,
						meta: {},
					}),
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(s._relationsCreated.length).toBe(0);
			expect(s._relationsUpdated.length).toBe(0);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('stale directus_relations row'),
			);
		});

		it('rebuilds relations whose on_delete drifted from the expected value', async () => {
			const s = makeServices({
				relations: {
					readOne: async (c: string, f: string) => ({
						collection: c,
						field: f,
						schema: { on_delete: 'NO ACTION' },
						meta: {},
					}),
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(s._relationsCreated.length).toBe(0);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('stale directus_relations row'),
			);
		});
	});

	describe('legacy column rename migration', () => {
		function makeDb() {
			const renames: Array<{ table: string; old: string; new: string }> = [];
			const hasColumn = vi.fn(async (_table: string, _col: string) => true);
			const alterTable = vi.fn(async (table: string, cb: (t: any) => void) => {
				cb({
					renameColumn: (oldName: string, newName: string) => {
						renames.push({ table, old: oldName, new: newName });
					},
				});
			});
			return {
				database: { schema: { hasColumn, alterTable } },
				renames,
				hasColumn,
				alterTable,
			};
		}

		it('renames legacy strings/unused_strings columns and deletes old field rows', async () => {
			const s = makeServices({
				items: {
					directus_fields: {
						rows: [
							{
								id: 'f-1',
								collection: 'email_template_translations',
								field: 'strings',
							},
							{
								id: 'f-2',
								collection: 'email_template_translations',
								field: 'unused_strings',
							},
						],
					},
				},
			});
			const logger = makeLogger();
			const { database, renames, alterTable } = makeDb();
			await runBootstrap(dir, s as any, getSchema, {}, logger, database);
			expect(alterTable).toHaveBeenCalledTimes(2);
			expect(renames).toEqual([
				{
					table: 'email_template_translations',
					old: 'strings',
					new: 'i18n_variables',
				},
				{
					table: 'email_template_translations',
					old: 'unused_strings',
					new: 'unused_i18n_variables',
				},
			]);
			// Old directus_fields rows were deleted so migrateCollectionFields
			// will recreate the new field meta cleanly.
			const remaining = (s._stores.directus_fields ?? []).map((r: any) => r.field);
			expect(remaining).not.toContain('strings');
			expect(remaining).not.toContain('unused_strings');
		});

		it('is a no-op when no legacy columns exist (idempotent)', async () => {
			const s = makeServices();
			const logger = makeLogger();
			const { database, alterTable } = makeDb();
			await runBootstrap(dir, s as any, getSchema, {}, logger, database);
			expect(alterTable).not.toHaveBeenCalled();
		});

		it('skips DB alter when database is not provided', async () => {
			const s = makeServices({
				items: {
					directus_fields: {
						rows: [
							{
								id: 'f-1',
								collection: 'email_template_translations',
								field: 'strings',
							},
						],
					},
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			// Legacy rows remain untouched because we have no knex to rename.
			expect(s._stores.directus_fields?.some((r: any) => r.field === 'strings')).toBe(true);
		});

		it('skips renameColumn when DB column already absent (rerun safety)', async () => {
			const s = makeServices({
				items: {
					directus_fields: {
						rows: [
							{
								id: 'f-1',
								collection: 'email_template_translations',
								field: 'strings',
							},
						],
					},
				},
			});
			const logger = makeLogger();
			const { database, alterTable } = makeDb();
			(database.schema.hasColumn as any).mockImplementation(async () => false);
			await runBootstrap(dir, s as any, getSchema, {}, logger, database);
			expect(alterTable).not.toHaveBeenCalled();
			// Stale directus_fields row still gets cleaned up.
			expect((s._stores.directus_fields ?? []).some((r: any) => r.field === 'strings')).toBe(
				false,
			);
		});

		it('warns and bails when readByQuery for legacy fields throws', async () => {
			// Throw only for the legacy-rename query so the rest of bootstrap proceeds.
			const readByQuery = vi.fn(async (query?: any) => {
				const fieldFilter = query?.filter?.field;
				if (fieldFilter && '_in' in fieldFilter) {
					throw new Error('boom-readByQuery');
				}
				return [];
			});
			const s = makeServices({
				items: { directus_fields: { readByQuery } },
			});
			const logger = makeLogger();
			const { database, alterTable } = makeDb();
			await runBootstrap(dir, s as any, getSchema, {}, logger, database);
			expect(alterTable).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Could not query directus_fields for legacy column rename'),
			);
		});

		it('treats hasColumn throw as columnExists=true and still renames', async () => {
			const s = makeServices({
				items: {
					directus_fields: {
						rows: [
							{
								id: 'f-1',
								collection: 'email_template_translations',
								field: 'strings',
							},
						],
					},
				},
			});
			const logger = makeLogger();
			const { database, alterTable } = makeDb();
			(database.schema.hasColumn as any).mockImplementation(async () => {
				throw new Error('hasColumn-boom');
			});
			await runBootstrap(dir, s as any, getSchema, {}, logger, database);
			expect(alterTable).toHaveBeenCalled();
			// Legacy directus_fields row was deleted.
			expect((s._stores.directus_fields ?? []).some((r: any) => r.field === 'strings')).toBe(
				false,
			);
		});

		it('renames even when database.schema.hasColumn is missing entirely', async () => {
			const s = makeServices({
				items: {
					directus_fields: {
						rows: [
							{
								id: 'f-1',
								collection: 'email_template_translations',
								field: 'strings',
							},
						],
					},
				},
			});
			const logger = makeLogger();
			const { alterTable } = makeDb();
			// Custom database surface without `hasColumn`.
			const database = { schema: { alterTable } };
			await runBootstrap(dir, s as any, getSchema, {}, logger, database);
			expect(alterTable).toHaveBeenCalled();
		});

		it('warns and continues when alterTable throws', async () => {
			const s = makeServices({
				items: {
					directus_fields: {
						rows: [
							{
								id: 'f-1',
								collection: 'email_template_translations',
								field: 'strings',
							},
						],
					},
				},
			});
			const logger = makeLogger();
			const { database } = makeDb();
			(database.schema.alterTable as any).mockImplementation(async () => {
				throw new Error('alter-boom');
			});
			await runBootstrap(dir, s as any, getSchema, {}, logger, database);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Column rename failed for strings'),
			);
		});

		it('warns when fields.deleteOne throws but rename still happened', async () => {
			const deleteOne = vi.fn(async () => {
				throw new Error('delete-boom');
			});
			const s = makeServices({
				items: {
					directus_fields: {
						rows: [
							{
								id: 'f-1',
								collection: 'email_template_translations',
								field: 'strings',
							},
						],
						// readByQuery default works; only delete throws.
					},
				},
			});
			// Replace deleteOne on the directus_fields ItemsService instance.
			// The helpers don't expose a deleteOne override, so monkey-patch
			// via a custom ItemsService wrapper.
			const origItemsService = s.ItemsService;
			s.ItemsService = function (collection: string, opts: any) {
				const inst = new origItemsService(collection, opts);
				if (collection === 'directus_fields') {
					inst.deleteOne = deleteOne;
				}
				return inst;
			};
			const logger = makeLogger();
			const { database, alterTable } = makeDb();
			await runBootstrap(dir, s as any, getSchema, {}, logger, database);
			expect(alterTable).toHaveBeenCalled();
			expect(deleteOne).toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Could not delete legacy directus_fields row for strings'),
			);
		});

		it('skips deleteOne when legacy field row has no id', async () => {
			const s = makeServices({
				items: {
					directus_fields: {
						rows: [
							{
								// No id at all.
								collection: 'email_template_translations',
								field: 'strings',
							},
						],
					},
				},
			});
			const logger = makeLogger();
			const { database, alterTable } = makeDb();
			await runBootstrap(dir, s as any, getSchema, {}, logger, database);
			expect(alterTable).toHaveBeenCalled();
			// No warn about deleteOne — it was skipped, not failed.
			const warns = (logger.warn as any).mock.calls.flat().join('\n');
			expect(warns).not.toContain('Could not delete legacy directus_fields row');
		});
	});

	describe('language name capitalization backfill', () => {
		it('capitalizes leading lowercase letter for existing language rows', async () => {
			const s = makeServices({
				items: {
					languages: {
						rows: [
							{ id: 'fr-FR', code: 'fr-FR', name: 'français' },
							{ id: 'en-US', code: 'en-US', name: 'English' },
							{ id: 'de-DE', code: 'de-DE', name: 'deutsch' },
						],
					},
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			const langs = s._stores.languages ?? [];
			expect(langs.find((r: any) => r.code === 'fr-FR')?.name).toBe('Français');
			expect(langs.find((r: any) => r.code === 'de-DE')?.name).toBe('Deutsch');
			// Already-capitalized rows are untouched.
			expect(langs.find((r: any) => r.code === 'en-US')?.name).toBe('English');
		});

		it('is a no-op when all language names are already capitalized', async () => {
			const updateOne = vi.fn(async (id: string | number) => id);
			const s = makeServices({
				items: {
					languages: {
						rows: [{ id: 'en-US', code: 'en-US', name: 'English' }],
						updateOne,
					},
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(updateOne).not.toHaveBeenCalled();
		});

		it('warns and bails when reading languages throws', async () => {
			// languages.readByQuery is called twice: once by seedLanguages,
			// then by capitalizeLanguageNames. Let the first call resolve so
			// seeding proceeds, then throw on the capitalization read.
			let calls = 0;
			const readByQuery = vi.fn(async () => {
				calls += 1;
				if (calls === 1) return [];
				throw new Error('lang-read-boom');
			});
			const s = makeServices({
				items: {
					languages: { readByQuery },
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Could not read languages for capitalization backfill'),
			);
		});

		it('warns per-row when updateOne throws but processes other rows', async () => {
			const updateOne = vi.fn(async (id: string | number) => {
				if (id === 'fr-FR') throw new Error('update-boom');
				return id;
			});
			const s = makeServices({
				items: {
					languages: {
						rows: [
							{ id: 'fr-FR', code: 'fr-FR', name: 'français' },
							{ id: 'de-DE', code: 'de-DE', name: 'deutsch' },
						],
						updateOne,
					},
				},
			});
			const logger = makeLogger();
			await runBootstrap(dir, s as any, getSchema, {}, logger);
			expect(updateOne).toHaveBeenCalledWith('fr-FR', { name: 'Français' });
			expect(updateOne).toHaveBeenCalledWith('de-DE', { name: 'Deutsch' });
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Could not update language fr-FR name'),
			);
		});
	});
});
