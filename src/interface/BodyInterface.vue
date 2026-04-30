<script setup lang="ts">
import { inject, onMounted, ref, watch, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { extractI18nKeys } from '../liquid';
import { reconcileTranslationStrings } from '../reconcile';

/**
 * Wrapper around Directus's standard `input-code` interface used on
 * `email_templates.body`. Owns the i18n-variables refresh UX:
 *
 *   - "Refresh from body" button reconciles every translation row's
 *     `i18n_variables` / `unused_i18n_variables` against the current
 *     in-form body (across all languages, including ones that aren't
 *     currently mounted in the translations split-view).
 *   - "Auto on body blur" checkbox (per-user pref, persisted to
 *     `email_extension_user_prefs`) runs the same reconciliation on
 *     focus-out of the body field.
 *
 * Both paths emit a `setFieldValue` event for the sibling
 * `translations` field — Directus's `v-form` listens and updates its
 * modelValue. This is UI-only, never persisted until the user hits
 * Directus's Save button.
 */

type StringMap = Record<string, string>;
type TranslationRow = {
	id?: string | number;
	languages_code?: string;
	i18n_variables?: StringMap | null;
	unused_i18n_variables?: StringMap | null;
	[k: string]: unknown;
};
type RelationEdits = {
	create: Record<string, unknown>[];
	update: Record<string, unknown>[];
	delete: (string | number)[];
};

const props = withDefaults(
	defineProps<{
		value: string | null | undefined;
		disabled?: boolean;
		options?: Record<string, unknown>;
	}>(),
	{
		value: '',
		disabled: false,
		options: () => ({ language: 'htmlmixed', lineNumber: true }),
	},
);

const emit = defineEmits<{
	(e: 'input', value: string | null): void;
	(e: 'setFieldValue', payload: { field: string; value: unknown }): void;
}>();

const api = useApi();
const formValues = inject<Ref<Record<string, unknown>> | null>('values', null);

const userId = ref<string | null>(null);
const autoRefresh = ref(false);
const refreshing = ref(false);
const refreshError = ref<string | null>(null);
const lastSummary = ref<string | null>(null);

/**
 * Snapshot of the persisted `translations` rows captured the first
 * time we see them in their fetched (plain-array) shape. The
 * translations m2m interface flips `values.translations` from an
 * array to a `{create,update,delete}` edits object the moment any
 * other field on a row changes — at which point we'd lose the
 * original `i18n_variables` we need to reconcile against. This
 * snapshot stays the source of truth for our reconciliation across
 * the whole editing session.
 */
const fetchedSnapshot = ref<TranslationRow[] | null>(null);

const noopWarn = { warn: (): void => {} };

function onInput(next: string | null): void {
	emit('input', next);
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

function getCurrentEdits(): RelationEdits {
	const raw = formValues?.value?.translations as unknown;
	if (isEditsObject(raw)) {
		return {
			create: Array.isArray(raw.create) ? [...raw.create] : [],
			update: Array.isArray(raw.update) ? [...raw.update] : [],
			delete: Array.isArray(raw.delete) ? [...raw.delete] : [],
		};
	}
	return { create: [], update: [], delete: [] };
}

function captureSnapshotIfPossible(): void {
	if (fetchedSnapshot.value !== null) return;
	const raw = formValues?.value?.translations as unknown;
	if (Array.isArray(raw)) {
		// Deep-ish clone of the i18n maps so later in-place edits to
		// formValues never mutate our snapshot.
		fetchedSnapshot.value = (raw as TranslationRow[]).map((row) => ({
			...row,
			i18n_variables: row.i18n_variables ? { ...row.i18n_variables } : null,
			unused_i18n_variables: row.unused_i18n_variables ? { ...row.unused_i18n_variables } : null,
		}));
	}
}

/**
 * Reconcile every translation row's i18n maps against the current
 * body and produce the m2m-edits payload that Directus's translations
 * interface expects. Existing edits in `update[]` / `create[]` are
 * preserved — we only patch the two i18n fields per row.
 */
function reconcileAll(body: string): { payload: RelationEdits; changed: number } {
	captureSnapshotIfPossible();
	const keys = extractI18nKeys(body ?? '', 'body-interface-refresh', noopWarn);
	const edits = getCurrentEdits();
	let changed = 0;

	// Patch persisted rows (those that have an `id`) via update[].
	const fetched = fetchedSnapshot.value ?? [];
	for (const row of fetched) {
		if (row.id === undefined) continue;
		const existingUpdateIdx = edits.update.findIndex(
			(u) => (u as Record<string, unknown>).id === row.id,
		);
		const existingUpdate =
			existingUpdateIdx >= 0
				? (edits.update[existingUpdateIdx] as Record<string, unknown>)
				: null;
		// The "current" maps for reconciliation should reflect any
		// pending edits to those two specific fields, falling back to
		// the snapshot when none exist.
		const baseI18n =
			(existingUpdate?.i18n_variables as StringMap | null | undefined) ??
			row.i18n_variables ??
			{};
		const baseUnused =
			(existingUpdate?.unused_i18n_variables as StringMap | null | undefined) ??
			row.unused_i18n_variables ??
			{};
		const result = reconcileTranslationStrings(baseI18n, baseUnused, keys);
		if (!result.changed) continue;
		changed += 1;
		const patched: Record<string, unknown> = {
			...(existingUpdate ?? {}),
			id: row.id,
			i18n_variables: result.i18n_variables,
			unused_i18n_variables: result.unused_i18n_variables,
		};
		if (existingUpdateIdx >= 0) {
			edits.update[existingUpdateIdx] = patched;
		} else {
			edits.update.push(patched);
		}
	}

	// Patch newly-created (unsaved) rows in-place inside create[].
	for (let i = 0; i < edits.create.length; i++) {
		const entry = edits.create[i] as Record<string, unknown>;
		const baseI18n = (entry.i18n_variables as StringMap | null | undefined) ?? {};
		const baseUnused = (entry.unused_i18n_variables as StringMap | null | undefined) ?? {};
		const result = reconcileTranslationStrings(baseI18n, baseUnused, keys);
		if (!result.changed) continue;
		changed += 1;
		edits.create[i] = {
			...entry,
			i18n_variables: result.i18n_variables,
			unused_i18n_variables: result.unused_i18n_variables,
		};
	}

	return { payload: edits, changed };
}

function refreshNow(reason: 'manual' | 'blur'): void {
	if (props.disabled) return;
	refreshError.value = null;
	const body = typeof props.value === 'string' ? props.value : '';
	const { payload, changed } = reconcileAll(body);
	emit('setFieldValue', { field: 'translations', value: payload });
	if (reason === 'manual') {
		lastSummary.value =
			changed === 0
				? 'Already in sync — nothing to update.'
				: `Updated ${changed} translation${changed === 1 ? '' : 's'}.`;
	} else {
		lastSummary.value = null;
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

function onFocusOut(): void {
	if (!autoRefresh.value) return;
	try {
		refreshNow('blur');
	} catch {
		// Best-effort; never block typing.
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

// Clear the manual summary when the body changes — keeps the message
// honest (it described a previous reconciliation).
watch(
	() => props.value,
	() => {
		lastSummary.value = null;
	},
);

// Capture the initial fetched translations array before the m2m
// interface flips it into edit-object shape on the user's first
// touch. `immediate: true` covers the case where translations are
// already loaded by the time we mount.
watch(
	() => formValues?.value?.translations,
	() => {
		captureSnapshotIfPossible();
	},
	{ immediate: true, deep: false },
);

onMounted(async () => {
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
</script>

<template>
	<div class="body-i18n-aware" @focusout="onFocusOut">
		<interface-input-code
			:value="value"
			:disabled="disabled"
			:language="(options.language as string) ?? 'htmlmixed'"
			:line-number="options.lineNumber !== false"
			@input="onInput" />
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
	</div>
</template>

<style scoped>
.body-i18n-aware {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.i18n-toolbar {
	display: flex;
	align-items: center;
	gap: 12px;
	flex-wrap: wrap;
	margin-block-start: 4px;
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
