<script setup lang="ts">
/**
 * Passive `email_templates.body` wrapper around Directus's standard
 * `input-code` interface. Emits `i18n-email:body-snapshot` on every
 * input change and `i18n-email:body-blur` on focus-out so the
 * companion `translations-i18n-aware` interface can reconcile the
 * translation rows' i18n maps without a sibling-field write.
 *
 * Owns NO refresh UI: the button + auto-refresh checkbox + status
 * live on the translations wrapper, where the data being mutated
 * actually lives.
 */

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
}>();

function dispatchSnapshot(body: string | null): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(
		new CustomEvent('i18n-email:body-snapshot', {
			detail: { body: typeof body === 'string' ? body : '' },
		}),
	);
}

function onInput(next: string | null): void {
	emit('input', next);
	dispatchSnapshot(next);
}

function resolvedLanguage(): string {
	const lang = props.options?.language;
	return typeof lang === 'string' && lang.length > 0 ? lang : 'htmlmixed';
}

function resolvedLineNumber(): boolean {
	return props.options?.lineNumber !== false;
}

function onFocusOut(): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(
		new CustomEvent('i18n-email:body-blur', {
			detail: { body: typeof props.value === 'string' ? props.value : '' },
		}),
	);
}
</script>

<template>
	<div class="body-i18n-aware" @focusout="onFocusOut">
		<interface-input-code
			:value="value"
			:disabled="disabled"
			:language="resolvedLanguage()"
			:line-number="resolvedLineNumber()"
			@input="onInput" />
	</div>
</template>

<style scoped>
.body-i18n-aware {
	display: flex;
	flex-direction: column;
	gap: 8px;
}
</style>
