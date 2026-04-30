import { defineInterface } from '@directus/extensions-sdk';
import StringsInterfaceComponent from './StringsInterface.vue';

/**
 * Custom interface for the JSON `i18n_variables` and `unused_i18n_variables` fields on
 * `email_template_translations`. Renders one `v-textarea` per key with a
 * Form ⇄ JSON view toggle. The `variant` option controls whether the editor
 * shows delete buttons (used on the `unused_i18n_variables` field).
 */
export default defineInterface({
	id: 'i18n-strings-editor',
	name: 'i18n Strings Editor',
	icon: 'translate',
	description: 'Per-key textarea editor for i18n translation maps with a JSON fallback view.',
	component: StringsInterfaceComponent,
	types: ['json'],
	options: [
		{
			field: 'variant',
			name: 'Variant',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'select-dropdown',
				options: {
					choices: [
						{ text: 'Active (no delete)', value: 'active' },
						{ text: 'Unused (with delete)', value: 'unused' },
					],
				},
				note: 'Active hides per-row delete; Unused shows them.',
			},
			schema: { default_value: 'active' },
		},
	],
});
