import { defineInterface } from '@directus/extensions-sdk';
import BodyInterfaceComponent from './BodyInterface.vue';

/**
 * Drop-in replacement for the standard `input-code` interface used on
 * `email_templates.body`. Behaviour is identical except that it
 * dispatches a `i18n-email:body-blur` window CustomEvent on focus-out
 * with `{ templateId, body }`. The `i18n-strings-editor` interface
 * listens for this event when the user opts into auto-refresh so the
 * variables list rebuilds without leaving the form.
 */
export default defineInterface({
	id: 'body-i18n-aware',
	name: 'i18n Body (auto-refresh source)',
	icon: 'code',
	description:
		'Liquid body editor that emits a blur event consumed by the i18n variables interface.',
	component: BodyInterfaceComponent,
	types: ['text', 'string'],
	options: [
		{
			field: 'language',
			name: 'Language',
			type: 'string',
			meta: { width: 'half', interface: 'input' },
			schema: { default_value: 'htmlmixed' },
		},
		{
			field: 'lineNumber',
			name: 'Show line numbers',
			type: 'boolean',
			meta: { width: 'half', interface: 'boolean' },
			schema: { default_value: true },
		},
	],
});
