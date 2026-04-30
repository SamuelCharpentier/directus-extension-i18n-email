import type { TemplateCategory } from './constants';

/**
 * Minimal structural Logger shape matching the subset of pino's Logger
 * interface that Directus passes to hooks. Avoids a hard dependency on
 * `pino` just for the type.
 */
export type Logger = {
	info: (msg: string) => void;
	warn: (msg: string) => void;
	error: (msg: string) => void;
};

/** Flat key→string map injected into Liquid as `{{ i18n.* }}`. */
export type TranslationStrings = Record<string, string>;

/**
 * Unified shape stored in `email_template_translations.i18n_variables`.
 * `in_template` = keys currently referenced by the parent template body.
 * `unused` = keys preserved from previous edits (still hold their values
 * in case the admin re-adds the variable to the body).
 */
export type I18nVariables = {
	in_template: TranslationStrings;
	unused: TranslationStrings;
};

export type EmailTemplateRow = {
	id?: string;
	template_key: string;
	category: TemplateCategory;
	body: string;
	description: string | null;
	is_active: boolean;
	is_protected: boolean;
	checksum: string;
	last_synced_at: string | null;
};

export type EmailTemplateTranslationRow = {
	id?: string;
	email_templates_id: string;
	languages_code: string;
	subject: string;
	from_name: string | null;
	/**
	 * Stored shape is `I18nVariables`, but the row may arrive from the DB
	 * driver as a JSON string (driver-dependent) or in the legacy
	 * bare-key shape from older boots. Server-side reconcile coerces
	 * to the canonical shape on every pass.
	 */
	i18n_variables: I18nVariables | TranslationStrings | string | null;
};

export type EmailTemplateVariableRow = {
	id?: string;
	template_key: string;
	variable_name: string;
	is_required: boolean;
	is_protected: boolean;
	description: string | null;
	example_value: string | null;
};

export type LanguageRow = {
	code: string;
	name?: string | null;
};

export type SeedTemplate = {
	template_key: string;
	category: TemplateCategory;
	body: string;
	description: string | null;
};

export type SeedTranslation = {
	template_key: string;
	languages_code: string;
	subject: string;
	from_name: string | null;
	i18n_variables: TranslationStrings;
};

export type SeedVariable = {
	template_key: string;
	variable_name: string;
	is_required: boolean;
	description: string | null;
	example_value: string | null;
};

export type SeedLanguage = {
	code: string;
};

/** Recipient user info auto-hydrated for protected system emails. */
export type RecipientUser = {
	id: string;
	first_name: string | null;
	last_name: string | null;
	email: string;
	language: string | null;
};
