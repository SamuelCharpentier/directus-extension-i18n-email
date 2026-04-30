import { defineInterface } from '@directus/extensions-sdk';
import JsonInterfaceComponent from './JsonInterface.vue';

/**
 * Custom interface for the unified JSON `i18n_variables` field on
 * `email_template_translations`. Renders two sections (`In template`
 * and `Unused`) with one `v-textarea` per key, plus a Form ⇄ JSON
 * view toggle. Reclassification between the two sections happens
 * automatically when the parent `translations-i18n-aware` interface
 * broadcasts on the `i18nBus`.
 */
export default defineInterface({
	id: 'i18n-strings-editor',
	name: 'i18n Strings Editor',
	icon: 'translate',
	description:
		'Two-section editor (In template / Unused) for i18n translation maps with a JSON fallback view.',
	component: JsonInterfaceComponent,
	types: ['json'],
	options: [],
});
