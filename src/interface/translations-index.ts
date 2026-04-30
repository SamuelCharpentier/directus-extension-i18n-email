import { defineInterface } from '@directus/extensions-sdk';
import TranslationsInterfaceComponent from './TranslationsInterface.vue';

/**
 * Drop-in wrapper around the standard `translations` interface used
 * on `email_templates.translations`. Adds a "Refresh i18n variables
 * from body" button and an "Auto on body blur" checkbox above the
 * standard split-view editor. Listens for body-change events
 * dispatched by the companion `body-i18n-aware` interface and
 * reconciles every translation row's `i18n_variables` /
 * `unused_i18n_variables` maps against the latest body, UI-only.
 */
export default defineInterface({
	id: 'translations-i18n-aware',
	name: 'i18n Translations (auto-refresh sink)',
	icon: 'translate',
	description:
		'Translations interface that reconciles per-language i18n variables against the template body on demand or on body blur.',
	component: TranslationsInterfaceComponent,
	types: ['alias'],
	localTypes: ['translations'],
	relational: true,
	options: [
		{
			field: 'languageField',
			name: 'Language Field',
			type: 'string',
			meta: { width: 'half', interface: 'input' },
			schema: { default_value: 'name' },
		},
		{
			field: 'defaultLanguage',
			name: 'Default Language',
			type: 'string',
			meta: { width: 'half', interface: 'input' },
		},
		{
			field: 'defaultOpenSplitView',
			name: 'Default Open Split View',
			type: 'boolean',
			meta: { width: 'half', interface: 'boolean' },
			schema: { default_value: false },
		},
		{
			field: 'userLanguage',
			name: 'Use User Language',
			type: 'boolean',
			meta: { width: 'half', interface: 'boolean' },
			schema: { default_value: true },
		},
	],
	recommendedDisplays: [],
});
