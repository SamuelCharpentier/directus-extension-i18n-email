import type { EmailOptions, HookConfig, SchemaOverview } from '@directus/types';
import { runBootstrap } from './bootstrap';
import { runSendFilter } from './send';
import { syncTemplateBody, deleteTemplateFile } from './sync';
import {
	LANGUAGES_COLLECTION,
	TEMPLATES_COLLECTION,
	TRANSLATIONS_COLLECTION,
	VARIABLES_COLLECTION,
} from './constants';
import { computeChecksum } from './integrity';
import { localizeLangCode } from './directus';
import { templateId, translationId, variableId } from './ids';
import {
	buildInitialStrings,
	coerceI18nVariables,
	fetchTemplateBodyById,
	reconcileTranslationsForTemplate,
} from './reconcile';
import type {
	EmailTemplateRow,
	EmailTemplateTranslationRow,
	EmailTemplateVariableRow,
	LanguageRow,
} from './types';

function templatesPathFromEnv(env: Record<string, unknown>): string {
	return typeof env['EMAIL_TEMPLATES_PATH'] === 'string'
		? (env['EMAIL_TEMPLATES_PATH'] as string)
		: '';
}

const hook: HookConfig = (
	{ filter, action, init },
	{ services, logger, getSchema, env, database },
) => {
	logger.info('[i18n-email] Hook registered.');

	// Captured during the delete filter (after the protection check
	// passes), drained by the paired delete action. Keyed by row id so
	// concurrent batched deletes don't trample each other. Entries
	// that never get drained (e.g. the DB delete failed downstream)
	// are harmless — the next delete of the same id overwrites them.
	const pendingFileDeletes = new Map<string, string>();

	// Bootstrap is intentionally fire-and-forget so it does NOT block
	// Directus's startup pipeline. On a fresh DB the work (collection
	// creation + seeds + body flush) takes 30-40s; awaiting it inside
	// the `server.start` hook would freeze the API for that whole
	// window. Each entry point below kicks the same idempotent
	// `runBootstrap` promise (it coalesces concurrent calls) and
	// returns immediately. Errors are logged inside runBootstrap.
	const kickBootstrap = (): void => {
		void runBootstrap(templatesPathFromEnv(env), services, getSchema, env, logger, database);
	};

	// Build ItemsService options for a filter, reusing the caller's
	// transaction (`context.database`) and schema when Directus supplies
	// them. On SQLite the pool holds a single connection: opening any DB
	// query without the transaction handle deadlocks for 60s and stalls
	// every other request with it.
	const svcOpts = (context: any, fallbackSchema: SchemaOverview) => ({
		schema: context?.schema ?? fallbackSchema,
		accountability: null,
		...(context?.database ? { knex: context.database } : {}),
	});

	// Give a filter-created row a deterministic primary key so the same
	// row seeded independently in another environment resolves to the
	// same id for directus-extension-schema-sync. No-op when the caller
	// already supplied an id (e.g. a schema-sync import). On the rare
	// collision (a template_key reused after a rename) the id stays
	// unset and Directus generates a random one.
	const assignDeterministicId = async (
		collection: string,
		candidate: string | null,
		row: { id?: unknown },
		context: any,
	): Promise<void> => {
		if (!candidate || row.id) return;
		try {
			const schema = context?.schema ?? (await getSchema());
			const items = new services.ItemsService(collection, svcOpts(context, schema));
			const existing = await items.readByQuery({
				filter: { id: { _eq: candidate } },
				fields: ['id'],
				limit: 1,
			});
			if (existing.length === 0) row.id = candidate;
		} catch {
			// Leave the id unset — Directus generates a random one.
		}
	};

	if (typeof init === 'function') {
		try {
			init('app.after', () => kickBootstrap());
		} catch {
			// Older Directus versions don't support this init event — fine.
		}
	}
	action('server.start', () => kickBootstrap());

	// ──────────── email.send filter ────────────
	filter('email.send', async (payload: unknown) => {
		const input = payload as EmailOptions;
		return runSendFilter(input, { services, getSchema, logger, env });
	});

	// ──────────── Body sync on create/update ────────────
	action(`${TEMPLATES_COLLECTION}.items.create`, async (meta: unknown) => {
		const row = (meta as { key?: string; payload?: Partial<EmailTemplateRow> }).payload;
		if (!row || !row.template_key) return;
		try {
			const schema = await getSchema();
			const key = (meta as { key?: string }).key;
			const full: EmailTemplateRow = {
				id: key ? String(key) : row.id,
				template_key: row.template_key,
				category: row.category ?? 'custom',
				body: row.body ?? '',
				description: row.description ?? null,
				is_active: row.is_active ?? true,
				is_protected: row.is_protected ?? false,
				checksum: row.checksum ?? '',
				last_synced_at: row.last_synced_at ?? null,
			};
			await syncTemplateBody(
				full,
				templatesPathFromEnv(env),
				services,
				schema,
				logger,
				'body-create',
			);
			await reconcileTranslationsForTemplate(full, services, schema, logger);
		} catch (err) {
			logger.error(`[i18n-email] Post-create sync failed: ${(err as Error).message}`);
		}
	});

	action(`${TEMPLATES_COLLECTION}.items.update`, async (meta: unknown) => {
		const keys = ((meta as { keys?: string[] }).keys ?? []) as string[];
		const patch = (meta as { payload?: Partial<EmailTemplateRow> }).payload ?? {};
		// Only resync when body changed (or when we don't know the patch).
		if (keys.length === 0) return;
		if (Object.keys(patch).length > 0 && !('body' in patch) && !('template_key' in patch)) {
			return;
		}
		try {
			const schema = await getSchema();
			const items = new services.ItemsService(TEMPLATES_COLLECTION, {
				schema,
				accountability: null,
			});
			const rows = (await items.readMany(keys)) as EmailTemplateRow[];
			for (const row of rows) {
				await syncTemplateBody(
					row,
					templatesPathFromEnv(env),
					services,
					schema,
					logger,
					'body-update',
				);
				await reconcileTranslationsForTemplate(row, services, schema, logger);
			}
		} catch (err) {
			logger.error(`[i18n-email] Post-update sync failed: ${(err as Error).message}`);
		}
	});

	// ──────────── Checksum maintenance + deterministic id ────────────
	filter(
		`${TEMPLATES_COLLECTION}.items.create`,
		async (payload: unknown, _meta: unknown, context: any) => {
			const row = payload as Partial<EmailTemplateRow>;
			row.checksum = computeChecksum({ body: row.body ?? '' });
			if (row.template_key) {
				await assignDeterministicId(
					TEMPLATES_COLLECTION,
					templateId(row.template_key),
					row,
					context,
				);
			}
			return row;
		},
	);

	// ──────────── Auto-fill languages.name from `code` ────────────
	// The translations interface uses `name` as the tab label; we keep
	// admins from having to supply it manually.
	filter(`${LANGUAGES_COLLECTION}.items.create`, async (payload: unknown) => {
		const row = payload as Partial<LanguageRow>;
		if (!row.code || row.name) return row;
		row.name = localizeLangCode(row.code);
		return row;
	});

	filter(`${TEMPLATES_COLLECTION}.items.update`, async (payload: unknown) => {
		const patch = payload as Partial<EmailTemplateRow>;
		if ('body' in patch) {
			patch.checksum = computeChecksum({ body: patch.body ?? '' });
		}
		return patch;
	});

	// ──────────── Pre-fill `i18n_variables` on translation create ────────────
	// When an admin adds a new language for an existing template, derive
	// the empty key map from the parent body so the UI lands on a fully
	// scaffolded form. Existing values supplied in the create payload
	// are preserved (and coerced to the canonical shape if the caller
	// supplied legacy bare keys, e.g. seeds).
	filter(
		`${TRANSLATIONS_COLLECTION}.items.create`,
		async (payload: unknown, _meta: unknown, context: any) => {
			const row = payload as Partial<EmailTemplateTranslationRow>;
			const parentId = row.email_templates_id;
			if (parentId && row.languages_code) {
				await assignDeterministicId(
					TRANSLATIONS_COLLECTION,
					translationId(String(parentId), row.languages_code),
					row,
					context,
				);
			}
			if (!parentId) return row;
			const incoming = row.i18n_variables;
			const incomingHasKeys =
				(typeof incoming === 'string' && incoming.trim().length > 0) ||
				(incoming &&
					typeof incoming === 'object' &&
					!Array.isArray(incoming) &&
					Object.keys(incoming as Record<string, unknown>).length > 0);
			if (incomingHasKeys) {
				row.i18n_variables = coerceI18nVariables(
					incoming as Parameters<typeof coerceI18nVariables>[0],
				);
				return row;
			}
			try {
				const schema = context?.schema ?? (await getSchema());
				const tpl = await fetchTemplateBodyById(
					String(parentId),
					services,
					schema,
					logger,
					context?.database,
				);
				if (tpl) {
					row.i18n_variables = buildInitialStrings(tpl.body, tpl.template_key, logger);
				}
			} catch (err) {
				logger.warn(`[i18n-email] Translation pre-fill skipped: ${(err as Error).message}`);
			}
			if (!row.i18n_variables) row.i18n_variables = { in_template: {}, unused: {} };
			return row;
		},
	);

	// ──────────── Deterministic id for new variable registry rows ────────────
	filter(
		`${VARIABLES_COLLECTION}.items.create`,
		async (payload: unknown, _meta: unknown, context: any) => {
			const row = payload as Partial<EmailTemplateVariableRow>;
			if (row.template_key && row.variable_name) {
				await assignDeterministicId(
					VARIABLES_COLLECTION,
					variableId(row.template_key, row.variable_name),
					row,
					context,
				);
			}
			return row;
		},
	);

	// ──────────── Protected-row delete guards ────────────
	filter(
		`${TEMPLATES_COLLECTION}.items.delete`,
		async (payload: unknown, _meta: unknown, context: any) => {
			const ids = ((payload as (string | number)[] | undefined) ?? []).map(String);
			if (ids.length === 0) return payload;
			const schema = context?.schema ?? (await getSchema());
			const items = new services.ItemsService(TEMPLATES_COLLECTION, svcOpts(context, schema));
			const rows = (await items.readMany(ids, {
				fields: ['id', 'template_key', 'is_protected'],
			})) as Array<Pick<EmailTemplateRow, 'id' | 'template_key' | 'is_protected'>>;
			const blocked = rows.filter((r) => r.is_protected);
			if (blocked.length > 0) {
				const keys = blocked.map((r) => r.template_key).join(', ');
				throw new Error(
					`[i18n-email] Cannot delete protected template row(s): ${keys}. Protected rows can be edited but not removed.`,
				);
			}
			// Stash template_keys so the paired action hook can remove the
			// matching .liquid files once the DB delete succeeds.
			for (const r of rows) {
				if (r.id && r.template_key) pendingFileDeletes.set(String(r.id), r.template_key);
			}
			return payload;
		},
	);

	action(`${TEMPLATES_COLLECTION}.items.delete`, async (meta: unknown) => {
		const keys = ((meta as { keys?: (string | number)[] }).keys ?? []).map(String);
		if (keys.length === 0) return;
		const templatesPath = templatesPathFromEnv(env);
		for (const id of keys) {
			const templateKey = pendingFileDeletes.get(id);
			pendingFileDeletes.delete(id);
			if (!templateKey) continue;
			await deleteTemplateFile(templatesPath, templateKey, logger);
		}
	});

	filter(
		`${VARIABLES_COLLECTION}.items.delete`,
		async (payload: unknown, _meta: unknown, context: any) => {
			const ids = ((payload as (string | number)[] | undefined) ?? []).map(String);
			if (ids.length === 0) return payload;
			const schema = context?.schema ?? (await getSchema());
			const items = new services.ItemsService(VARIABLES_COLLECTION, svcOpts(context, schema));
			const rows = (await items.readMany(ids, {
				fields: ['id', 'template_key', 'variable_name', 'is_protected'],
			})) as EmailTemplateVariableRow[];
			const blocked = rows.filter((r) => r.is_protected);
			if (blocked.length > 0) {
				const keys = blocked.map((r) => `${r.template_key}.${r.variable_name}`).join(', ');
				throw new Error(
					`[i18n-email] Cannot delete protected variable registry entr(ies): ${keys}.`,
				);
			}
			return payload;
		},
	);
};

export default hook;
