<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type StringMap = Record<string, string>;

const props = withDefaults(
	defineProps<{
		value: StringMap | string | null | undefined;
		disabled?: boolean;
		variant?: 'active' | 'unused';
	}>(),
	{
		value: () => ({}),
		disabled: false,
		variant: 'active',
	},
);

const emit = defineEmits<{
	(e: 'input', value: StringMap | null): void;
}>();

/** Coerce the incoming `value` (object, JSON string, null) into a plain map. */
function coerce(v: StringMap | string | null | undefined): StringMap {
	if (v === null || v === undefined) return {};
	if (typeof v === 'string') {
		const trimmed = v.trim();
		if (!trimmed) return {};
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as StringMap;
			}
		} catch {
			return {};
		}
		return {};
	}
	if (typeof v === 'object' && !Array.isArray(v)) return { ...(v as StringMap) };
	return {};
}

const view = ref<'form' | 'json'>('form');
const local = ref<StringMap>(coerce(props.value));
const jsonText = ref<string>(JSON.stringify(local.value, null, 2));
const jsonError = ref<string | null>(null);

/** Refs to each visible textarea, keyed by variable name, for autogrow. */
const textareaRefs = ref<Record<string, HTMLTextAreaElement | null>>({});
const jsonTextareaRef = ref<HTMLTextAreaElement | null>(null);

function autogrow(el: HTMLTextAreaElement | null | undefined): void {
	if (!el) return;
	// Skip when not yet laid out — ResizeObserver will retry once it is.
	if (el.offsetParent === null && el.offsetHeight === 0) return;
	// Reset first so shrinking works, then size to content.
	el.style.height = 'auto';
	el.style.height = `${el.scrollHeight}px`;
}

/** Resize all visible textareas (after a render or value change). */
function autogrowAll(): void {
	for (const el of Object.values(textareaRefs.value)) autogrow(el);
	autogrow(jsonTextareaRef.value);
}

/**
 * ResizeObserver + element registry: every observed textarea gets a
 * recomputed height whenever its own size changes (e.g. font load,
 * tab becoming visible, parent split-view animation finishing). This
 * is the robust fix for the on-load case where layout isn't ready
 * during onMounted.
 */
const observed = new WeakSet<HTMLTextAreaElement>();
let resizeObserver: ResizeObserver | null = null;

function observe(el: HTMLTextAreaElement | null): void {
	if (!el || observed.has(el)) return;
	if (!resizeObserver) return;
	resizeObserver.observe(el);
	observed.add(el);
}

watch(
	() => props.value,
	(next) => {
		const incoming = coerce(next);
		// Avoid stomping in-progress edits if the form value matches our local state.
		if (JSON.stringify(incoming) !== JSON.stringify(local.value)) {
			local.value = incoming;
			jsonText.value = JSON.stringify(incoming, null, 2);
			jsonError.value = null;
			void nextTick(autogrowAll);
		}
	},
	{ deep: true },
);

watch(view, () => {
	void nextTick(autogrowAll);
});

const sortedKeys = computed(() => Object.keys(local.value).sort((a, b) => a.localeCompare(b)));
const isEmpty = computed(() => sortedKeys.value.length === 0);
const toggleLabel = computed(() => (view.value === 'form' ? 'JSON' : 'Form'));
const toggleIcon = computed(() => (view.value === 'form' ? 'data_object' : 'view_list'));

function commit(next: StringMap): void {
	local.value = next;
	jsonText.value = JSON.stringify(next, null, 2);
	jsonError.value = null;
	emit('input', next);
}

function onValueInput(key: string, ev: Event): void {
	const target = ev.target as HTMLTextAreaElement;
	const next: StringMap = { ...local.value, [key]: target.value };
	local.value = next;
	jsonText.value = JSON.stringify(next, null, 2);
	jsonError.value = null;
	emit('input', next);
	autogrow(target);
}

function onDelete(key: string): void {
	if (props.disabled) return;
	const updated: StringMap = { ...local.value };
	delete updated[key];
	commit(updated);
	void nextTick(autogrowAll);
}

function onJsonInput(ev: Event): void {
	const target = ev.target as HTMLTextAreaElement;
	const text = target.value;
	jsonText.value = text;
	autogrow(target);
	const trimmed = text.trim();
	if (!trimmed) {
		jsonError.value = null;
		local.value = {};
		emit('input', {});
		return;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			jsonError.value = 'JSON must be an object of string values.';
			return;
		}
		const obj = parsed as Record<string, unknown>;
		const out: StringMap = {};
		for (const [k, v] of Object.entries(obj)) {
			if (typeof v !== 'string') {
				jsonError.value = `Value for "${k}" must be a string.`;
				return;
			}
			out[k] = v;
		}
		jsonError.value = null;
		local.value = out;
		emit('input', out);
	} catch (err) {
		jsonError.value = err instanceof Error ? err.message : 'Invalid JSON.';
	}
}

function isWarn(key: string): boolean {
	if (props.variant !== 'active') return false;
	const v = local.value[key];
	return v === undefined || v === null || v.trim() === '';
}

function setTextareaRef(key: string, el: Element | null): void {
	textareaRefs.value[key] = el as HTMLTextAreaElement | null;
	observe(el as HTMLTextAreaElement | null);
	autogrow(el as HTMLTextAreaElement | null);
}

function setJsonTextareaRef(el: Element | null): void {
	jsonTextareaRef.value = el as HTMLTextAreaElement | null;
	observe(el as HTMLTextAreaElement | null);
	autogrow(el as HTMLTextAreaElement | null);
}

onMounted(() => {
	if (typeof ResizeObserver !== 'undefined') {
		resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) autogrow(entry.target as HTMLTextAreaElement);
		});
		// Re-attach observers for any refs registered before mount.
		for (const el of Object.values(textareaRefs.value)) observe(el);
		observe(jsonTextareaRef.value);
	}
	// One more pass once the browser has had a frame to compute layout —
	// covers the case where textareas are inserted in a hidden tab or
	// split-view that becomes visible after mount.
	requestAnimationFrame(() => {
		requestAnimationFrame(autogrowAll);
	});
});

onBeforeUnmount(() => {
	resizeObserver?.disconnect();
	resizeObserver = null;
});
</script>

<template>
	<div
		class="i18n-strings-editor"
		:class="[`variant-${variant}`, { 'is-empty': isEmpty }]">
		<div class="toolbar">
			<span class="spacer" />
			<v-button
				small
				secondary
				:disabled="disabled"
				@click="view = view === 'form' ? 'json' : 'form'">
				<v-icon :name="toggleIcon" left small />
				{{ toggleLabel }}
			</v-button>
		</div>

		<div v-if="view === 'form'" class="form-view">
			<div v-if="isEmpty" class="empty">
				<v-icon name="inbox" />
				<span>{{
					variant === 'unused' ? 'No unused variables.' : 'No variables yet.'
				}}</span>
			</div>
			<div v-else class="rows">
				<div
					v-for="key in sortedKeys"
					:key="key"
					class="row"
					:class="{ warn: isWarn(key) }">
					<div class="key-bar">
						<v-icon
							v-if="isWarn(key)"
							name="warning"
							small
							class="warn-icon"
							v-tooltip="'Empty value — translation missing'" />
						<code class="key-name">{{ key }}</code>
						<span class="spacer" />
						<v-button
							v-if="variant === 'unused'"
							icon
							x-small
							secondary
							:disabled="disabled"
							v-tooltip="'Remove this variable'"
							@click="onDelete(key)">
							<v-icon name="delete" small />
						</v-button>
					</div>
					<textarea
						class="value-textarea"
						:ref="(el) => setTextareaRef(key, el as Element | null)"
						:value="local[key] ?? ''"
						:disabled="disabled"
						:placeholder="isWarn(key) ? 'Missing translation…' : ''"
						rows="1"
						@input="onValueInput(key, $event)" />
				</div>
			</div>
		</div>

		<div v-else class="json-view">
			<textarea
				class="value-textarea json-area"
				:ref="(el) => setJsonTextareaRef(el as Element | null)"
				:value="jsonText"
				:disabled="disabled"
				placeholder="{}"
				spellcheck="false"
				rows="3"
				@input="onJsonInput($event)" />
			<div v-if="jsonError" class="json-error">
				<v-icon name="error" small />
				<span>{{ jsonError }}</span>
			</div>
		</div>
	</div>
</template>

<style scoped>
.i18n-strings-editor {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.toolbar {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
}

.toolbar .spacer {
	flex: 1 1 auto;
}

.empty {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 16px;
	color: var(--theme--foreground-subdued, var(--foreground-subdued));
	border: 1px dashed var(--theme--border-color-subdued, var(--border-subdued));
	border-radius: var(--theme--border-radius, 6px);
}

.rows {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.row {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding: 6px 8px;
	border-radius: var(--theme--border-radius, 6px);
	border: 1px solid transparent;
}

.row.warn {
	background: color-mix(in srgb, var(--theme--warning, #ffa439) 8%, transparent);
	border-color: color-mix(in srgb, var(--theme--warning, #ffa439) 35%, transparent);
}

.key-bar {
	display: flex;
	align-items: center;
	gap: 6px;
	font-family: var(--theme--font-family-monospace, monospace);
	font-size: 13px;
	font-weight: 600;
	color: var(--theme--form--field--label--foreground, var(--foreground-normal));
}

.key-bar .key-name {
	word-break: break-all;
}

.key-bar .warn-icon {
	color: var(--theme--warning, #ffa439);
}

.key-bar .spacer {
	flex: 1 1 auto;
}

.value-textarea {
	width: 100%;
	min-height: 44px;
	padding: 10px 12px;
	font-family: var(--theme--form--field--input--font-family, var(--family-sans-serif));
	font-size: 14px;
	line-height: 1.5;
	color: var(--theme--form--field--input--foreground, var(--foreground-normal));
	background-color: var(--theme--form--field--input--background, var(--background-page));
	border: var(--theme--border-width, 2px) solid
		var(--theme--form--field--input--border-color, var(--border-normal));
	border-radius: var(--theme--border-radius, 6px);
	resize: none;
	overflow: hidden;
	box-sizing: border-box;
	transition: border-color var(--fast, 150ms);
}

.value-textarea:hover:not(:disabled) {
	border-color: var(
		--theme--form--field--input--border-color-hover,
		var(--border-normal-alt)
	);
}

.value-textarea:focus {
	outline: none;
	border-color: var(--theme--form--field--input--border-color-focus, var(--primary));
}

.value-textarea:disabled {
	color: var(--theme--form--field--input--foreground-subdued, var(--foreground-subdued));
	background-color: var(
		--theme--form--field--input--background-subdued,
		var(--background-subdued)
	);
	cursor: not-allowed;
}

.json-area {
	font-family: var(--theme--font-family-monospace, monospace);
	font-size: 13px;
	min-height: 80px;
}

.json-view {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.json-error {
	display: flex;
	align-items: center;
	gap: 6px;
	color: var(--theme--danger, #e35169);
	font-size: 12px;
}
</style>
