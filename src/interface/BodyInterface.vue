<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/**
 * Thin wrapper around Directus's standard `input-code` interface that
 * dispatches a window-level CustomEvent when the body field loses
 * focus. Listened to by `i18n-strings-editor` (variant=active) when
 * the user has opted into auto-refresh — lets the i18n variables list
 * stay in sync with the body without leaving the form.
 *
 * Also listens for `i18n-email:request-body-blur` so the variables
 * editor's manual "Refresh from body" button can pull the *current,
 * unsaved* body value from the live form rather than the DB.
 *
 * Forwards all input events transparently and never mutates the value
 * itself, so Directus's dirty-state tracking remains intact.
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

const formValues = inject<Ref<Record<string, unknown>> | null>('values', null);

const root = ref<HTMLElement | null>(null);

function dispatchBlur(): void {
	const id =
		(formValues?.value?.id as string | number | undefined) ??
		(formValues?.value?.template_key as string | undefined) ??
		null;
	const detail = {
		templateId: id,
		body: typeof props.value === 'string' ? props.value : '',
	};
	try {
		window.dispatchEvent(new CustomEvent('i18n-email:body-blur', { detail }));
	} catch {
		// Swallow — running outside a window context shouldn't crash the form.
	}
}

function onFocusOut(): void {
	dispatchBlur();
}

function onRequestBlur(ev: Event): void {
	// Honour optional templateId scoping so a request from one form
	// doesn't trigger blurs on every body wrapper on the page.
	const detail = (ev as CustomEvent<{ templateId?: unknown }>).detail ?? {};
	const myId =
		(formValues?.value?.id as string | number | undefined) ??
		(formValues?.value?.template_key as string | undefined) ??
		null;
	if (detail.templateId && myId && detail.templateId !== myId) return;
	dispatchBlur();
}

function onInput(next: string | null): void {
	emit('input', next);
}

onMounted(() => {
	window.addEventListener('i18n-email:request-body-blur', onRequestBlur);
});

onBeforeUnmount(() => {
	window.removeEventListener('i18n-email:request-body-blur', onRequestBlur);
});
</script>

<template>
	<div
		ref="root"
		class="body-i18n-aware"
		@focusout="onFocusOut">
		<interface-input-code
			:value="value"
			:disabled="disabled"
			:language="(options.language as string) ?? 'htmlmixed'"
			:line-number="options.lineNumber !== false"
			@input="onInput" />
	</div>
</template>

<style scoped>
.body-i18n-aware {
	display: contents;
}
</style>
