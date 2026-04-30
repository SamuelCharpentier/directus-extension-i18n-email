<script setup lang="ts">
import { computed, ref, watch } from 'vue';

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

watch(
	() => props.value,
	(next) => {
		const incoming = coerce(next);
		// Avoid stomping in-progress edits if the form value matches our local state.
		if (JSON.stringify(incoming) !== JSON.stringify(local.value)) {
			local.value = incoming;
			jsonText.value = JSON.stringify(incoming, null, 2);
			jsonError.value = null;
		}
	},
	{ deep: true },
);

const sortedKeys = computed(() => Object.keys(local.value).sort((a, b) => a.localeCompare(b)));
const isEmpty = computed(() => sortedKeys.value.length === 0);

function commit(next: StringMap): void {
	local.value = next;
	jsonText.value = JSON.stringify(next, null, 2);
	jsonError.value = null;
	emit('input', next);
}

function onValueInput(key: string, next: string): void {
	const updated: StringMap = { ...local.value, [key]: next };
	commit(updated);
}

function onDelete(key: string): void {
	if (props.disabled) return;
	const updated: StringMap = { ...local.value };
	delete updated[key];
	commit(updated);
}

function onJsonInput(text: string): void {
	jsonText.value = text;
	const trimmed = text.trim();
	if (!trimmed) {
		jsonError.value = null;
		commit({});
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
</script>

<template>
	<div class="i18n-strings-editor">
		<div class="toolbar">
			<v-button-group rounded>
				<v-button
					small
					:secondary="view !== 'form'"
					:disabled="disabled"
					@click="view = 'form'"
				>
					<v-icon name="view_list" left small />
					Form
				</v-button>
				<v-button
					small
					:secondary="view !== 'json'"
					:disabled="disabled"
					@click="view = 'json'"
				>
					<v-icon name="data_object" left small />
					JSON
				</v-button>
			</v-button-group>
		</div>

		<div v-if="view === 'form'" class="form-view">
			<div v-if="isEmpty" class="empty">
				<v-icon name="inbox" />
				<span>{{ variant === 'unused' ? 'No unused variables.' : 'No variables yet.' }}</span>
			</div>
			<div v-else class="rows">
				<div
					v-for="key in sortedKeys"
					:key="key"
					class="row"
					:class="{ warn: isWarn(key) }"
				>
					<div class="key">
						<v-icon
							v-if="isWarn(key)"
							name="warning"
							small
							class="warn-icon"
							v-tooltip="'Empty value — translation missing'"
						/>
						<code>{{ key }}</code>
					</div>
					<div class="value">
						<v-textarea
							:model-value="local[key] ?? ''"
							:disabled="disabled"
							autogrow
							expand-on-focus
							:placeholder="isWarn(key) ? 'Missing translation…' : ''"
							@update:model-value="onValueInput(key, $event)"
						/>
					</div>
					<div class="actions">
						<v-button
							v-if="variant === 'unused'"
							icon
							x-small
							secondary
							:disabled="disabled"
							v-tooltip="'Remove this variable'"
							@click="onDelete(key)"
						>
							<v-icon name="delete" />
						</v-button>
					</div>
				</div>
			</div>
		</div>

		<div v-else class="json-view">
			<v-textarea
				:model-value="jsonText"
				:disabled="disabled"
				class="json-area"
				:placeholder="'{}'"
				@update:model-value="onJsonInput($event)"
			/>
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
	justify-content: flex-end;
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
	gap: 6px;
}

.row {
	display: grid;
	grid-template-columns: minmax(140px, 220px) 1fr 36px;
	gap: 8px;
	align-items: start;
	padding: 6px 8px;
	border-radius: var(--theme--border-radius, 6px);
	border: 1px solid transparent;
}

.row.warn {
	background: color-mix(in srgb, var(--theme--warning, #ffa439) 8%, transparent);
	border-color: color-mix(in srgb, var(--theme--warning, #ffa439) 35%, transparent);
}

.row .key {
	display: flex;
	align-items: center;
	gap: 6px;
	padding-top: 8px;
	font-family: var(--theme--font-family-monospace, monospace);
	font-size: 13px;
	word-break: break-all;
}

.row .key .warn-icon {
	color: var(--theme--warning, #ffa439);
}

.row .value {
	min-width: 0;
}

.row .actions {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	padding-top: 6px;
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
