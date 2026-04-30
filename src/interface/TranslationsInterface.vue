<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { extractI18nKeys } from '../liquid';
import { reconcileTranslationStrings } from '../reconcile';

/**
 * Wrapper around Directus's standard `translations` interface used on
 * `email_templates.translations`. Owns the i18n-variables refresh UX:
 *
 *   - "Refresh from body" button reconciles every translation row's
 *     `i18n_variables` / `unused_i18n_variables` against the latest
 *     body snapshot received from the body interface.
 *   - "Auto on body blur" checkbox (per-user pref) runs the same
 *     reconciliation when the body field loses focus.
 *
 * Why here and not on the body interface: this component owns the
 * `translations` field's modelValue and can call the standard
 * `emit('input', ...)` contract directly. The previous `setFieldValue`
 * round-trip through `v-form` was fragile (m2m edits-object shape
 * guessing, value flipping between array and object, string-encoded
 * nested JSON). Owning the value end-to-end avoids all of that.
 *
 * Body↔translations communication happens via window CustomEvents:
 *   - `i18n-email:body-snapshot` — fired on every body input change.
 *   - `i18n-email:body-blur` — fired on body focus-out.
 */

type StringMap = Record<string, string>;
type TranslationRow = {
	id?: string | number;
	languages_code?: string;
	i18n_variables?: StringMap | string | null;
	unused_i18n_variables?: StringMap | string | null;
	[k: string]: unknown;
};
type RelationEdits = {
	create: Record<string, unknown>[];
	update: Record<string, unknown>[];
	delete: (string | number)[];
};

const props = withDefaults(
	defineProps<{
		value: unknown;
		disabled?: boolean;
		collection?: string;
		field?: string;
		primaryKey?: string | number;
		version?: unknown;
		// Forwarded options for the wrapped standard `translations` interface.
		languageField?: string | null;
		languageDirectionField?: string | null;
		defaultLanguage?: string | null;
		defaultOpenSplitView?: boolean;
		userLanguage?: boolean;
	}>(),
	{
		disabled: false,
		collection: undefined,
		field: undefined,
		primaryKey: undefined,
		version: undefined,
		languageField: 'name',
		languageDirectionField: 'direction',
		defaultLanguage: null,
		defaultOpenSplitView: false,
		userLanguage: true,
	},
);

const emit = defineEmits<{
	(e: 'input', value: unknown): void;
}>();

const api = useApi();

const userId = ref<string | null>(null);
const autoRefresh = ref(false);
const refreshing = ref(false);
const refreshError = ref<string | null>(null);
const lastSummary = ref<string | null>(null);

/**
 * Latest body string we've seen via `i18n-email:body-snapshot`. Lazy:
 * if the user clicks Refresh before any snapshot has arrived (rare —
 * snapshots fire on every keystroke), we fall back to an empty body
 * which produces an empty key set and no changes.
 */
const lastBody = ref<string>('');

const noopWarn = { warn: (): void => {} };

function parseMap(v: unknown): StringMap {
	if (!v) return {};
	if (typeof v === 'string') {
		try {
			const parsed = JSON.parse(v);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as StringMap)
				: {};
		} catch {
			return {};
		}
	}
	if (typeof v === 'object' && !Array.isArray(v)) return { ...(v as StringMap) };
	return {};
}

function isEditsObject(v: unknown): v is RelationEdits {
	return (
		!!v &&
		typeof v === 'object' &&
		!Array.isArray(v) &&
		'create' in (v as Record<string, unknown>) &&
		'update' in (v as Record<string, unknown>) &&
		'delete' in (v as Record<string, unknown>)
	);
}

/**
 * Reconcile every persisted + pending translation row against the
 * given body and return the new value to emit, plus the count of
 * rows whose i18n maps actually changed.
 *
 * Handles both shapes the m2m `value` can take:
 *   - Plain array (initial fetched state, before any edit).
 *   - `{ create, update, delete }` edits object (after first user edit).
 */
function reconcile(body: string): { next: unknown; changed: number } {
	const keys = extractI18nKeys(body, 'translations-interface', noopWarn);
	const raw = props.value;
	let changed = 0;

	if (Array.isArray(raw)) {
		// Fetched array: build a fresh edits object containing only
		// rows whose i18n maps changed. Untouched rows stay implicit
		// (Directus treats anything missing from `update[]` as "no
		// change to that row").
		const update: Record<string, unknown>[] = [];
		for (const row of raw as TranslationRow[]) {
			if (row.id === undefined) continue;
			const result = reconcileTranslationStrings(
				parseMap(row.i18n_variables),
				parseMap(row.unused_i18n_variables),
				keys,
			);
			if (!result.changed) continue;
			changed += 1;
			update.push({
				id: row.id,
				i18n_variables: result.i18n_variables,
				unused_i18n_variables: result.unused_i18n_variables,
			});
		}
		if (changed === 0) return { next: raw, changed: 0 };
		return { next: { create: [], update, delete: [] }, changed };
	}

	if (isEditsObject(raw)) {
		const next: RelationEdits = {
			create: Array.isArray(raw.create) ? [...raw.create] : [],
			update: Array.isArray(raw.update) ? [...raw.update] : [],
			delete: Array.isArray(raw.delete) ? [...raw.delete] : [],
		};

		// Patch newly-created (unsaved) rows in place.
		for (let i = 0; i < next.create.length; i++) {
			const entry = next.create[i] as Record<string, unknown>;
			const result = reconcileTranslationStrings(
				parseMap(entry.i18n_variables),
				parseMap(entry.unused_i18n_variables),
				keys,
			);
			if (!result.changed) continue;
			changed += 1;
			next.create[i] = {
				...entry,
				i18n_variables: result.i18n_variables,
				unused_i18n_variables: result.unused_i18n_variables,
			};
		}

		// We can only reconcile persisted rows whose i18n maps appear
		// somewhere in the form state. Without a fetched array, the
		// only rows we can act on here are those already represented
		// in `update[]` (e.g. the user previously edited a translation
		// string). Persisted rows untouched in this session aren't
		// addressable from the edits-object alone; the body interface's
		// snapshots fire on every keystroke, so by the time the user
		// clicks Refresh we typically still hold the original array
		// shape.
		for (let i = 0; i < next.update.length; i++) {
			const entry = next.update[i] as Record<string, unknown>;
			if (entry.id === undefined) continue;
			const result = reconcileTranslationStrings(
				parseMap(entry.i18n_variables),
				parseMap(entry.unused_i18n_variables),
				keys,
			);
			if (!result.changed) continue;
			changed += 1;
			next.update[i] = {
				...entry,
				i18n_variables: result.i18n_variables,
				unused_i18n_variables: result.unused_i18n_variables,
			};
		}

		return { next, changed };
	}

	return { next: raw, changed: 0 };
}

function refreshNow(reason: 'manual' | 'blur'): void {
	if (props.disabled) return;
	refreshError.value = null;
	const { next, changed } = reconcile(lastBody.value);
	emit('input', next);
	if (reason === 'manual') {
		lastSummary.value =
			changed === 0
				? 'Already in sync — nothing to update.'
				: `Updated ${changed} translation${changed === 1 ? '' : 's'}.`;
	}
}

function onClickRefresh(): void {
	if (refreshing.value) return;
	refreshing.value = true;
	try {
		refreshNow('manual');
	} catch (err) {
		refreshError.value = err instanceof Error ? err.message : 'Refresh failed.';
	} finally {
		refreshing.value = false;
	}
}

async function onToggleAutoRefresh(next: boolean): Promise<void> {
	autoRefresh.value = next;
	if (!userId.value) return;
	try {
		await api.patch(`/items/email_extension_user_prefs/${userId.value}`, {
			auto_refresh_i18n_on_body_change: next,
		});
	} catch {
		try {
			await api.post('/items/email_extension_user_prefs', {
				user: userId.value,
				auto_refresh_i18n_on_body_change: next,
			});
		} catch {
			// Best-effort: pref not persisted, but in-session toggle still works.
		}
	}
}

function onBodySnapshot(ev: Event): void {
	const detail = (ev as CustomEvent<{ body?: string }>).detail;
	if (typeof detail?.body === 'string') {
		lastBody.value = detail.body;
	}
}

function onBodyBlur(ev: Event): void {
	const detail = (ev as CustomEvent<{ body?: string }>).detail;
	if (typeof detail?.body === 'string') {
		lastBody.value = detail.body;
	}
	if (!autoRefresh.value || props.disabled) return;
	try {
		refreshNow('blur');
	} catch {
		// Best-effort; never block typing.
	}
}

onMounted(async () => {
	if (typeof window !== 'undefined') {
		window.addEventListener('i18n-email:body-snapshot', onBodySnapshot);
		window.addEventListener('i18n-email:body-blur', onBodyBlur);
	}
	try {
		const me = await api.get('/users/me', { params: { fields: 'id' } });
		userId.value = (me?.data?.data?.id as string | undefined) ?? null;
		if (userId.value) {
			const pref = await api
				.get(`/items/email_extension_user_prefs/${userId.value}`)
				.catch(() => null);
			autoRefresh.value = pref?.data?.data?.auto_refresh_i18n_on_body_change === true;
		}
	} catch {
		// User store not reachable — auto-refresh stays off.
	}
});

onBeforeUnmount(() => {
	if (typeof window === 'undefined') return;
	window.removeEventListener('i18n-email:body-snapshot', onBodySnapshot);
	window.removeEventListener('i18n-email:body-blur', onBodyBlur);
});
</script>

<template>
	<div class="translations-i18n-aware">
		<div class="i18n-toolbar">
			<v-button
				small
				secondary
				:loading="refreshing"
				:disabled="disabled || refreshing"
				v-tooltip="
					'Re-extract i18n.* keys from the body and reconcile every translation. UI only — does not save.'
				"
				@click="onClickRefresh">
				<v-icon name="refresh" left small />
				Refresh i18n variables from body
			</v-button>
			<label class="auto-refresh">
				<v-checkbox
					:model-value="autoRefresh"
					:disabled="disabled"
					@update:model-value="onToggleAutoRefresh" />
				<span
					v-tooltip="
						'When on, every translation row is reconciled whenever the body loses focus.'
					">
					Auto on body blur
				</span>
			</label>
			<span class="spacer" />
			<span v-if="lastSummary" class="summary">{{ lastSummary }}</span>
		</div>
		<div v-if="refreshError" class="refresh-error">
			<v-icon name="error" small />
			<span>{{ refreshError }}</span>
		</div>
		<interface-translations
			:value="value"
			:disabled="disabled"
			:collection="collection"
			:field="field"
			:primary-key="primaryKey"
			:version="version"
			:language-field="languageField"
			:language-direction-field="languageDirectionField"
			:default-language="defaultLanguage"
			:default-open-split-view="defaultOpenSplitView"
			:user-language="userLanguage"
			@input="emit('input', $event)" />
	</div>
</template>

<style scoped>
.translations-i18n-aware {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.i18n-toolbar {
	display: flex;
	align-items: center;
	gap: 12px;
	flex-wrap: wrap;
}

.i18n-toolbar .spacer {
	flex: 1 1 auto;
}

.auto-refresh {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 13px;
	color: var(--theme--foreground-subdued, var(--foreground-subdued));
	cursor: pointer;
	user-select: none;
}

.summary {
	font-size: 12px;
	color: var(--theme--foreground-subdued, var(--foreground-subdued));
}

.refresh-error {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	color: var(--theme--danger, #e35168);
	font-size: 13px;
}
</style>
