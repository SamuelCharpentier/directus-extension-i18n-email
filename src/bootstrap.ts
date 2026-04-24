import type { ExtensionsServices, SchemaOverview } from '@directus/types';
import type { Logger } from './types';
import {
	TEMPLATES_COLLECTION,
	VARIABLES_COLLECTION,
	SYNC_AUDIT_COLLECTION,
	PROTECTED_TEMPLATE_KEYS,
} from './constants';
import {
	ALL_COLLECTIONS,
	EMAIL_TEMPLATES_COLLECTION,
	EMAIL_TEMPLATE_VARIABLES_COLLECTION,
	EMAIL_TEMPLATE_SYNC_AUDIT_COLLECTION,
} from './schema';
import { SEED_TEMPLATES, SEED_VARIABLES } from './seeds';
import { computeChecksum } from './integrity';
import { syncAllLocales } from './sync';

let bootstrapRan = false;
let bootstrapInFlight: Promise<void> | null = null;

async function collectionExists(
	collection: string,
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<boolean> {
	try {
		const collectionsService = new services.CollectionsService({
			schema,
			accountability: null,
		});
		await collectionsService.readOne(collection);
		return true;
	} catch {
		return false;
	}
}

async function createCollectionIfMissing(
	payload: (typeof ALL_COLLECTIONS)[number],
	services: ExtensionsServices,
	schema: SchemaOverview,
	logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<void> {
	if (await collectionExists(payload.collection, services, schema)) return;
	const collectionsService = new services.CollectionsService({ schema, accountability: null });
	await collectionsService.createOne(payload as any);
	logger.info(`[i18n-email] Created collection ${payload.collection}.`);
}

function isProtectedKey(key: string): boolean {
	return (PROTECTED_TEMPLATE_KEYS as readonly string[]).includes(key);
}

async function seedTemplates(
	services: ExtensionsServices,
	schema: SchemaOverview,
	logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<void> {
	const items = new services.ItemsService(TEMPLATES_COLLECTION, {
		schema,
		accountability: null,
	});
	for (const seed of SEED_TEMPLATES) {
		const existing = await items.readByQuery({
			filter: {
				template_key: { _eq: seed.template_key },
				language: { _eq: seed.language },
			},
			limit: 1,
		});
		if (existing.length > 0) continue;
		const checksum = computeChecksum({
			subject: seed.subject,
			from_name: seed.from_name,
			strings: seed.strings,
		});
		await items.createOne({
			template_key: seed.template_key,
			language: seed.language,
			category: seed.category,
			subject: seed.subject,
			from_name: seed.from_name,
			strings: seed.strings,
			description: seed.description,
			is_active: true,
			is_protected: isProtectedKey(seed.template_key),
			version: 1,
			checksum,
			last_synced_at: null,
		});
		logger.info(`[i18n-email] Seeded template ${seed.template_key} (${seed.language}).`);
	}
}

async function seedVariables(
	services: ExtensionsServices,
	schema: SchemaOverview,
	logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<void> {
	const items = new services.ItemsService(VARIABLES_COLLECTION, {
		schema,
		accountability: null,
	});
	for (const seed of SEED_VARIABLES) {
		const existing = await items.readByQuery({
			filter: {
				template_key: { _eq: seed.template_key },
				variable_name: { _eq: seed.variable_name },
			},
			limit: 1,
		});
		if (existing.length > 0) continue;
		await items.createOne({
			template_key: seed.template_key,
			variable_name: seed.variable_name,
			is_required: seed.is_required,
			is_protected: isProtectedKey(seed.template_key),
			description: seed.description,
			example_value: seed.example_value,
		});
		logger.info(`[i18n-email] Seeded variable ${seed.template_key}.${seed.variable_name}.`);
	}
}

/**
 * Idempotent bootstrap: creates collections if missing, seeds protected
 * system templates, and syncs initial locale files to disk. Safe to run
 * on every startup. Never overwrites admin-edited rows.
 */
export async function runBootstrap(
	templatesPath: string,
	services: ExtensionsServices,
	getSchema: () => Promise<SchemaOverview>,
	logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<void> {
	if (bootstrapRan) return;
	if (bootstrapInFlight) return bootstrapInFlight;

	bootstrapInFlight = (async () => {
		logger.info('[i18n-email] Bootstrap started.');
		try {
			let schema = await getSchema();
			await createCollectionIfMissing(EMAIL_TEMPLATES_COLLECTION, services, schema, logger);
			await createCollectionIfMissing(
				EMAIL_TEMPLATE_VARIABLES_COLLECTION,
				services,
				schema,
				logger,
			);
			await createCollectionIfMissing(
				EMAIL_TEMPLATE_SYNC_AUDIT_COLLECTION,
				services,
				schema,
				logger,
			);
			// Re-fetch schema after collection creation so ItemsService sees new collections.
			schema = await getSchema();
			await seedTemplates(services, schema, logger);
			await seedVariables(services, schema, logger);
			await syncAllLocales(templatesPath, services, schema, logger);
			bootstrapRan = true;
			logger.info('[i18n-email] Bootstrap completed.');
		} catch (err) {
			logger.error(
				`[i18n-email] Bootstrap failed (non-strict, extension will continue): ${(err as Error).message}`,
			);
		} finally {
			bootstrapInFlight = null;
		}
	})();

	return bootstrapInFlight;
}

// Exported for tests.
export const __INTERNAL__ = {
	reset(): void {
		bootstrapRan = false;
		bootstrapInFlight = null;
	},
	get ran(): boolean {
		return bootstrapRan;
	},
	collections: {
		TEMPLATES_COLLECTION,
		VARIABLES_COLLECTION,
		SYNC_AUDIT_COLLECTION,
	},
};
