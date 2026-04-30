import type { EmailOptions, HookConfig } from '@directus/types';
import { runBootstrap } from './bootstrap';
import { runSendFilter } from './send';
import { syncTemplateBody } from './sync';
import {
	LANGUAGES_COLLECTION,
	TEMPLATES_COLLECTION,
	TRANSLATIONS_COLLECTION,
	VARIABLES_COLLECTION,
} from './constants';
import { computeChecksum } from './integrity';
import { localizeLangCode } from './directus';
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

	if (typeof init === 'function') {
		try {
			init('app.after', () => kickBootstrap());
		} catch {
			// Older Directus versions don't support this init event — fine.
		}
	}
	action('server.start', () => kickBootstrap());
	// Eager kick-off — runBootstrap guards against concurrent runs.
	kickBootstrap();

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

	// ──────────── Checksum maintenance ────────────
	filter(`${TEMPLATES_COLLECTION}.items.create`, async (payload: unknown) => {
		const row = payload as Partial<EmailTemplateRow>;
		row.checksum = computeChecksum({ body: row.body ?? '' });
		return row;
	});

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
	filter(`${TRANSLATIONS_COLLECTION}.items.create`, async (payload: unknown) => {
		const row = payload as Partial<EmailTemplateTranslationRow>;
		const parentId = row.email_templates_id;
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
			const schema = await getSchema();
			const tpl = await fetchTemplateBodyById(String(parentId), services, schema, logger);
			if (tpl) {
				row.i18n_variables = buildInitialStrings(tpl.body, tpl.template_key, logger);
			}
		} catch (err) {
			logger.warn(`[i18n-email] Translation pre-fill skipped: ${(err as Error).message}`);
		}
		if (!row.i18n_variables) row.i18n_variables = { in_template: {}, unused: {} };
		return row;
	});

	// ──────────── Protected-row delete guards ────────────
	filter(`${TEMPLATES_COLLECTION}.items.delete`, async (payload: unknown) => {
		const ids = ((payload as (string | number)[] | undefined) ?? []).map(String);
		if (ids.length === 0) return payload;
		const schema = await getSchema();
		const items = new services.ItemsService(TEMPLATES_COLLECTION, {
			schema,
			accountability: null,
		});
		const rows = (await items.readMany(ids, {
			fields: ['id', 'template_key', 'is_protected'],
		})) as Array<Pick<EmailTemplateRow, 'template_key' | 'is_protected'>>;
		const blocked = rows.filter((r) => r.is_protected);
		if (blocked.length > 0) {
			const keys = blocked.map((r) => r.template_key).join(', ');
			throw new Error(
				`[i18n-email] Cannot delete protected template row(s): ${keys}. Protected rows can be edited but not removed.`,
			);
		}
		return payload;
	});

	filter(`${VARIABLES_COLLECTION}.items.delete`, async (payload: unknown) => {
		const ids = ((payload as (string | number)[] | undefined) ?? []).map(String);
		if (ids.length === 0) return payload;
		const schema = await getSchema();
		const items = new services.ItemsService(VARIABLES_COLLECTION, {
			schema,
			accountability: null,
		});
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
	});
};

export default hook;
