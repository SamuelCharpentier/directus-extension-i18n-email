<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { extractI18nKeys } from '../liquid';
import { dlog } from './debug';
import { dispatchReconcile } from './i18nBus';

/**
 * Wrapper around Directus's standard `translations` interface used on
 * `email_templates.translations`. Owns the i18n-variables refresh UX:
 *
 *   - "Refresh from body" button extracts `i18n.*` keys from the
 *     latest body snapshot and broadcasts them via the `i18nBus`
 *     window event. Every mounted `JsonInterface` (one per
 *     language tab) reclassifies its own local value against the
 *     broadcast keys. Lazy-mounted languages catch up via
 *     `getLastBroadcast()` on mount.
 *   - "Auto on body blur" checkbox (per-user pref) fires the same
 *     broadcast when the body field loses focus.
 *
 * This component intentionally does NOT touch the wrapped
 * `translations` value — the m2m field's value is a PK array
 * (e.g. `['uuid-1', 'uuid-2']`), so attempting to reconcile per-row
 * data through it is a no-op. Each language's `JsonInterface` owns
 * its own row state and emits its own `input` events through the
 * normal Directus pipeline; the bus is purely for cross-tab
 * coordination.
 *
 * Body↔translations communication happens via window CustomEvents:
 *   - `i18n-email:body-snapshot` — fired on every body input change.
 *   - `i18n-email:body-blur` — fired on body focus-out.
 *   - `i18n-email:reconcile-keys` — fired by Refresh / auto-blur.
 */

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
const prefRowExists = ref(false);
const refreshing = ref(false);
const refreshError = ref<string | null>(null);
const lastSummary = ref<string | null>(null);

/**
 * Latest body string we've seen via `i18n-email:body-snapshot`. If
 * the user clicks Refresh before any snapshot has arrived (rare —
 * snapshots fire on every keystroke), we fall back to an empty
 * body which produces an empty key set.
 */
const lastBody = ref<string>('');

const noopWarn = { warn: (): void => {} };
const LOG = '[i18n-email/translations]';

function broadcastFromBody(reason: 'manual' | 'blur'): void {
	if (props.disabled) return;
	refreshError.value = null;
	const keys = extractI18nKeys(lastBody.value, 'translations-interface', noopWarn);
	dlog(`${LOG} ${reason} broadcast: ${keys.size} key(s)`, Array.from(keys));
	dispatchReconcile(keys);
	if (reason === 'manual') {
		lastSummary.value =
			keys.size === 0
				? 'No i18n.* keys found in the body.'
				: `Broadcast ${keys.size} key${keys.size === 1 ? '' : 's'} to open language tabs.`;
	}
}

/**
 * Pull a fresh body snapshot from `BodyInterface` before broadcasting.
 * Avoids the first-load bug where `lastBody` is `''` (no prior input
 * events) and the Refresh broadcast empties every language tab's
 * `in_template`. Resolves on first matching `body-snapshot` or after
 * a short timeout (in which case we proceed with whatever `lastBody`
 * currently holds — preserves prior behavior if no `BodyInterface`
 * is mounted, e.g. admin swapped the body field's interface).
 */
function awaitFreshBody(timeoutMs = 50): Promise<void> {
	if (typeof window === 'undefined') return Promise.resolve();
	return new Promise<void>((resolve) => {
		let done = false;
		const settle = (): void => {
			if (done) return;
			done = true;
			window.removeEventListener('i18n-email:body-snapshot', listener);
			clearTimeout(timer);
			resolve();
		};
		const listener = (ev: Event): void => {
			const detail = (ev as CustomEvent<{ body?: string }>).detail;
			if (typeof detail?.body === 'string') lastBody.value = detail.body;
			settle();
		};
		const timer = window.setTimeout(settle, timeoutMs);
		window.addEventListener('i18n-email:body-snapshot', listener);
		window.dispatchEvent(new CustomEvent('i18n-email:body-request'));
	});
}

async function onClickRefresh(): Promise<void> {
	if (refreshing.value) return;
	refreshing.value = true;
	try {
		await awaitFreshBody();
		broadcastFromBody('manual');
	} catch (err) {
		refreshError.value = err instanceof Error ? err.message : 'Refresh failed.';
	} finally {
		refreshing.value = false;
	}
}

async function onToggleAutoRefresh(next: boolean): Promise<void> {
	autoRefresh.value = next;
	if (!userId.value) return;
	// SQLite returns booleans as 0/1 ints, and Directus 11's PATCH on a
	// missing item silently returns 204 rather than 404. We track row
	// existence explicitly so each toggle issues exactly one request:
	// POST when the row hasn't been created yet, PATCH thereafter.
	if (prefRowExists.value) {
		try {
			await api.patch(`/items/email_extension_user_prefs/${userId.value}`, {
				auto_refresh_i18n_on_body_change: next,
			});
		} catch {
			// Best-effort: pref not persisted, but in-session toggle still works.
		}
		return;
	}
	try {
		await api.post('/items/email_extension_user_prefs', {
			user: userId.value,
			auto_refresh_i18n_on_body_change: next,
		});
		prefRowExists.value = true;
	} catch {
		// Row likely already exists from a concurrent toggle / earlier
		// session; fall back to PATCH and remember it for next time.
		try {
			await api.patch(`/items/email_extension_user_prefs/${userId.value}`, {
				auto_refresh_i18n_on_body_change: next,
			});
			prefRowExists.value = true;
		} catch {
			// Best-effort: pref not persisted, but in-session toggle still works.
		}
	}
}

function onBodySnapshot(ev: Event): void {
	const detail = (ev as CustomEvent<{ body?: string }>).detail;
	if (typeof detail?.body === 'string') lastBody.value = detail.body;
}

function onBodyBlur(ev: Event): void {
	const detail = (ev as CustomEvent<{ body?: string }>).detail;
	if (typeof detail?.body === 'string') lastBody.value = detail.body;
	if (!autoRefresh.value || props.disabled) return;
	try {
		broadcastFromBody('blur');
	} catch {
		// Best-effort; never block typing.
	}
}

onMounted(async () => {
	dlog(`${LOG} mounted`);
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
			const row = pref?.data?.data;
			if (row) {
				prefRowExists.value = true;
				// SQLite returns booleans as 0/1 integers; coerce loosely.
				autoRefresh.value = Boolean(row.auto_refresh_i18n_on_body_change);
			}
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
					'Re-extract i18n.* keys from the body and reconcile every open language tab. UI only — does not save.'
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
						'When on, every open language tab is reconciled whenever the body loses focus.'
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
