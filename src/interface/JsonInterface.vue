<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { dlog } from './debug';
import { getLastBroadcast, subscribe, type Broadcast } from './i18nBus';

type StringMap = Record<string, string>;
type I18nVariables = { in_template: StringMap; unused: StringMap };
type Section = 'in_template' | 'unused';

const props = withDefaults(
	defineProps<{
		value?: I18nVariables | StringMap | string | null | undefined;
		disabled?: boolean;
	}>(),
	{
		value: () => ({ in_template: {}, unused: {} }),
		disabled: false,
	},
);

const emit = defineEmits<{
	(e: 'input', value: I18nVariables | null): void;
}>();

const LOG = '[i18n-email/json]';

/** Coerce arbitrary stored value into the canonical two-section shape. */
function coerce(v: I18nVariables | StringMap | string | null | undefined): I18nVariables {
	if (v === null || v === undefined) return { in_template: {}, unused: {} };
	if (typeof v === 'string') {
		const trimmed = v.trim();
		if (!trimmed) return { in_template: {}, unused: {} };
		try {
			const parsed = JSON.parse(trimmed);
			return coerce(parsed);
		} catch {
			return { in_template: {}, unused: {} };
		}
	}
	if (typeof v !== 'object' || Array.isArray(v)) return { in_template: {}, unused: {} };
	const obj = v as Record<string, unknown>;
	const hasIn = Object.prototype.hasOwnProperty.call(obj, 'in_template');
	const hasUnused = Object.prototype.hasOwnProperty.call(obj, 'unused');
	if (hasIn || hasUnused) {
		return {
			in_template: coerceFlatMap(obj['in_template']),
			unused: coerceFlatMap(obj['unused']),
		};
	}
	// Legacy bare-key shape — assume `in_template`.
	return { in_template: coerceFlatMap(obj), unused: {} };
}

function coerceFlatMap(v: unknown): StringMap {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
	const out: StringMap = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (typeof val === 'string') out[k] = val;
		else if (val === null || val === undefined) out[k] = '';
		else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val);
	}
	return out;
}

const view = ref<'form' | 'json'>('form');
const local = ref<I18nVariables>(coerce(props.value));
const jsonTextIn = ref<string>(JSON.stringify(local.value.in_template, null, 2));
const jsonTextUnused = ref<string>(JSON.stringify(local.value.unused, null, 2));
const jsonErrorIn = ref<string | null>(null);
const jsonErrorUnused = ref<string | null>(null);

/**
 * Newest broadcast we've already applied to local state. Compared
 * against `at` on incoming broadcasts to dedupe (e.g. mount-time
 * catch-up vs live event for the same broadcast).
 */
let lastAppliedAt: Date | null = null;

const textareaRefs = ref<Record<string, HTMLTextAreaElement | null>>({});
const jsonInRef = ref<HTMLTextAreaElement | null>(null);
const jsonUnusedRef = ref<HTMLTextAreaElement | null>(null);

function autogrow(el: HTMLTextAreaElement | null | undefined): void {
	if (!el) return;
	if (el.offsetParent === null && el.offsetHeight === 0) return;
	el.style.height = 'auto';
	el.style.height = `${el.scrollHeight}px`;
}

function autogrowAll(): void {
	for (const el of Object.values(textareaRefs.value)) autogrow(el);
	autogrow(jsonInRef.value);
	autogrow(jsonUnusedRef.value);
}

const observed = new WeakSet<HTMLTextAreaElement>();
let resizeObserver: ResizeObserver | null = null;

function observe(el: HTMLTextAreaElement | null): void {
	if (!el || observed.has(el) || !resizeObserver) return;
	resizeObserver.observe(el);
	observed.add(el);
}

watch(
	() => props.value,
	(next) => {
		const incoming = coerce(next);
		if (JSON.stringify(incoming) !== JSON.stringify(local.value)) {
			dlog(`${LOG} props.value changed — replacing local`);
			local.value = incoming;
			jsonTextIn.value = JSON.stringify(incoming.in_template, null, 2);
			jsonTextUnused.value = JSON.stringify(incoming.unused, null, 2);
			jsonErrorIn.value = null;
			jsonErrorUnused.value = null;
			void nextTick(autogrowAll);
		}
	},
	{ deep: true },
);

watch(view, () => {
	void nextTick(autogrowAll);
});

const sortedInKeys = computed(() =>
	Object.keys(local.value.in_template).sort((a, b) => a.localeCompare(b)),
);
const sortedUnusedKeys = computed(() =>
	Object.keys(local.value.unused).sort((a, b) => a.localeCompare(b)),
);
const isEmpty = computed(
	() => sortedInKeys.value.length === 0 && sortedUnusedKeys.value.length === 0,
);
const toggleLabel = computed(() => (view.value === 'form' ? 'JSON' : 'Form'));
const toggleIcon = computed(() => (view.value === 'form' ? 'data_object' : 'view_list'));

function commit(next: I18nVariables): void {
	local.value = next;
	jsonTextIn.value = JSON.stringify(next.in_template, null, 2);
	jsonTextUnused.value = JSON.stringify(next.unused, null, 2);
	jsonErrorIn.value = null;
	jsonErrorUnused.value = null;
	dlog(`${LOG} commit emit("input")`, next);
	emit('input', next);
}

function onValueInput(section: Section, key: string, ev: Event): void {
	const target = ev.target as HTMLTextAreaElement;
	const sectionMap: StringMap = { ...local.value[section], [key]: target.value };
	const next: I18nVariables =
		section === 'in_template'
			? { in_template: sectionMap, unused: { ...local.value.unused } }
			: { in_template: { ...local.value.in_template }, unused: sectionMap };
	local.value = next;
	jsonTextIn.value = JSON.stringify(next.in_template, null, 2);
	jsonTextUnused.value = JSON.stringify(next.unused, null, 2);
	emit('input', next);
	autogrow(target);
}

function onDelete(section: Section, key: string): void {
	if (props.disabled) return;
	const sectionMap: StringMap = { ...local.value[section] };
	delete sectionMap[key];
	const next: I18nVariables =
		section === 'in_template'
			? { in_template: sectionMap, unused: { ...local.value.unused } }
			: { in_template: { ...local.value.in_template }, unused: sectionMap };
	commit(next);
	void nextTick(autogrowAll);
}

function onJsonInput(section: Section, ev: Event): void {
	const target = ev.target as HTMLTextAreaElement;
	const text = target.value;
	if (section === 'in_template') jsonTextIn.value = text;
	else jsonTextUnused.value = text;
	autogrow(target);
	const trimmed = text.trim();
	const setError = (msg: string | null): void => {
		if (section === 'in_template') jsonErrorIn.value = msg;
		else jsonErrorUnused.value = msg;
	};
	if (!trimmed) {
		setError(null);
		const next: I18nVariables = {
			in_template: section === 'in_template' ? {} : { ...local.value.in_template },
			unused: section === 'unused' ? {} : { ...local.value.unused },
		};
		local.value = next;
		emit('input', next);
		return;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			setError('JSON must be an object of string values.');
			return;
		}
		const obj = parsed as Record<string, unknown>;
		const out: StringMap = {};
		for (const [k, v] of Object.entries(obj)) {
			if (typeof v !== 'string') {
				setError(`Value for "${k}" must be a string.`);
				return;
			}
			out[k] = v;
		}
		setError(null);
		const next: I18nVariables = {
			in_template: section === 'in_template' ? out : { ...local.value.in_template },
			unused: section === 'unused' ? out : { ...local.value.unused },
		};
		local.value = next;
		emit('input', next);
	} catch (err) {
		setError(err instanceof Error ? err.message : 'Invalid JSON.');
	}
}

function isWarn(key: string): boolean {
	const v = local.value.in_template[key];
	return v === undefined || v === null || v.trim() === '';
}

function setTextareaRef(section: Section, key: string, el: unknown): void {
	const ref = (el as HTMLTextAreaElement | null) ?? null;
	textareaRefs.value[`${section}::${key}`] = ref;
	observe(ref);
	autogrow(ref);
}

function setJsonRef(section: Section, el: unknown): void {
	const ref = (el as HTMLTextAreaElement | null) ?? null;
	if (section === 'in_template') jsonInRef.value = ref;
	else jsonUnusedRef.value = ref;
	observe(ref);
	autogrow(ref);
}

/**
 * Reclassify the current local value against a fresh set of keys
 * referenced by the parent template body. Pure: returns a new
 * `I18nVariables` plus a boolean indicating whether anything moved.
 *
 * Strict mode (no rename heuristics): a key in `in_template` that's
 * no longer referenced moves to `unused` (value preserved); a key
 * in `unused` that's now referenced moves to `in_template` (value
 * preserved); a referenced key absent from both gets seeded in
 * `in_template` with `''`.
 */
function reclassify(
	current: I18nVariables,
	keys: ReadonlySet<string>,
): {
	next: I18nVariables;
	changed: boolean;
} {
	const workIn: StringMap = { ...current.in_template };
	const workUnused: StringMap = { ...current.unused };

	for (const key of keys) {
		if (!(key in workIn)) {
			if (key in workUnused) {
				workIn[key] = workUnused[key]!;
				delete workUnused[key];
			} else {
				workIn[key] = '';
			}
		}
	}
	for (const key of Object.keys(workIn)) {
		if (!keys.has(key)) {
			workUnused[key] = workIn[key]!;
			delete workIn[key];
		}
	}

	const changed =
		!shallowEqual(current.in_template, workIn) || !shallowEqual(current.unused, workUnused);
	return { next: { in_template: workIn, unused: workUnused }, changed };
}

function shallowEqual(a: StringMap, b: StringMap): boolean {
	const ak = Object.keys(a);
	if (ak.length !== Object.keys(b).length) return false;
	for (const k of ak) if (a[k] !== b[k]) return false;
	return true;
}

function applyBroadcast(b: Broadcast): void {
	if (lastAppliedAt && b.at.getTime() <= lastAppliedAt.getTime()) {
		dlog(`${LOG} broadcast skipped (already applied at=${b.at.toISOString()})`);
		return;
	}
	const { next, changed } = reclassify(local.value, b.keys);
	lastAppliedAt = b.at;
	if (!changed) {
		dlog(`${LOG} broadcast applied — no change`);
		return;
	}
	dlog(`${LOG} broadcast applied — emitting`, next);
	commit(next);
	void nextTick(autogrowAll);
}

let unsubBus: (() => void) | null = null;

onMounted(() => {
	dlog(`${LOG} mounted; initial value =`, props.value);
	if (typeof ResizeObserver !== 'undefined') {
		resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) autogrow(entry.target as HTMLTextAreaElement);
		});
		for (const el of Object.values(textareaRefs.value)) observe(el);
		observe(jsonInRef.value);
		observe(jsonUnusedRef.value);
	}
	requestAnimationFrame(() => {
		requestAnimationFrame(autogrowAll);
	});
	// Mount-time catch-up: if a Refresh broadcast fired before this
	// language tab was opened, apply it now.
	const last = getLastBroadcast();
	if (last) applyBroadcast(last);
	// Live subscription for subsequent broadcasts.
	unsubBus = subscribe(applyBroadcast);
});

onBeforeUnmount(() => {
	resizeObserver?.disconnect();
	resizeObserver = null;
	unsubBus?.();
	unsubBus = null;
});
</script>

<template>
	<div class="i18n-strings-editor" :class="{ 'is-empty': isEmpty }">
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
			<!-- In-Template section -->
			<section class="section">
				<header class="section-header">
					<v-icon name="list_alt" small />
					<span>In template</span>
					<span class="count">{{ sortedInKeys.length }}</span>
				</header>
				<div v-if="sortedInKeys.length === 0" class="empty">
					<v-icon name="inbox" />
					<span>No variables referenced by the template body yet.</span>
				</div>
				<div v-else class="rows">
					<div
						v-for="key in sortedInKeys"
						:key="`in::${key}`"
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
						</div>
						<textarea
							class="value-textarea"
							:ref="(el) => setTextareaRef('in_template', key, el)"
							:value="local.in_template[key] ?? ''"
							:disabled="disabled"
							:placeholder="isWarn(key) ? 'Missing translation…' : ''"
							rows="1"
							@input="onValueInput('in_template', key, $event)" />
					</div>
				</div>
			</section>

			<!-- Unused section -->
			<section class="section">
				<header class="section-header">
					<v-icon name="archive" small />
					<span>Unused</span>
					<span class="count">{{ sortedUnusedKeys.length }}</span>
				</header>
				<div v-if="sortedUnusedKeys.length === 0" class="empty">
					<v-icon name="check_circle" />
					<span>No unused variables.</span>
				</div>
				<div v-else class="rows">
					<div v-for="key in sortedUnusedKeys" :key="`unused::${key}`" class="row">
						<div class="key-bar">
							<code class="key-name">{{ key }}</code>
							<span class="spacer" />
							<v-button
								icon
								x-small
								secondary
								:disabled="disabled"
								v-tooltip="'Remove this variable'"
								@click="onDelete('unused', key)">
								<v-icon name="delete" small />
							</v-button>
						</div>
						<textarea
							class="value-textarea"
							:ref="(el) => setTextareaRef('unused', key, el)"
							:value="local.unused[key] ?? ''"
							:disabled="disabled"
							rows="1"
							@input="onValueInput('unused', key, $event)" />
					</div>
				</div>
			</section>
		</div>

		<div v-else class="json-view">
			<section class="section">
				<header class="section-header">
					<v-icon name="list_alt" small />
					<span>In template</span>
				</header>
				<textarea
					class="value-textarea json-area"
					:ref="(el) => setJsonRef('in_template', el)"
					:value="jsonTextIn"
					:disabled="disabled"
					placeholder="{}"
					spellcheck="false"
					rows="3"
					@input="onJsonInput('in_template', $event)" />
				<div v-if="jsonErrorIn" class="json-error">
					<v-icon name="error" small />
					<span>{{ jsonErrorIn }}</span>
				</div>
			</section>
			<section class="section">
				<header class="section-header">
					<v-icon name="archive" small />
					<span>Unused</span>
				</header>
				<textarea
					class="value-textarea json-area"
					:ref="(el) => setJsonRef('unused', el)"
					:value="jsonTextUnused"
					:disabled="disabled"
					placeholder="{}"
					spellcheck="false"
					rows="3"
					@input="onJsonInput('unused', $event)" />
				<div v-if="jsonErrorUnused" class="json-error">
					<v-icon name="error" small />
					<span>{{ jsonErrorUnused }}</span>
				</div>
			</section>
		</div>
	</div>
</template>

<style scoped>
.i18n-strings-editor {
	display: flex;
	flex-direction: column;
	gap: 12px;
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

.form-view,
.json-view {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.section {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.section-header {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--theme--foreground-subdued, var(--foreground-subdued));
}

.section-header .count {
	margin-left: 4px;
	padding: 1px 6px;
	border-radius: 999px;
	background: var(--theme--background-subdued, var(--background-subdued));
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0;
}

.empty {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 12px 16px;
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
	border-color: var(--theme--form--field--input--border-color-hover, var(--border-normal-alt));
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

.json-error {
	display: flex;
	align-items: center;
	gap: 6px;
	color: var(--theme--danger, #e35169);
	font-size: 12px;
}
</style>
