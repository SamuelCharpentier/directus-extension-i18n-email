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

export type TemplateTrans = {
	subject?: string;
	from_name?: string;
	[key: string]: string | undefined;
};

export type LocaleData = {
	from_name?: string;
	[templateName: string]: TemplateTrans | string | undefined;
};

export type EmailTemplateRow = {
	id?: string;
	template_key: string;
	language: string;
	category: TemplateCategory;
	subject: string;
	from_name: string | null;
	strings: Record<string, string>;
	description: string | null;
	is_active: boolean;
	is_protected: boolean;
	version: number;
	checksum: string;
	last_synced_at: string | null;
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

export type SeedTemplate = {
	template_key: string;
	language: string;
	category: TemplateCategory;
	subject: string;
	from_name: string | null;
	strings: Record<string, string>;
	description: string | null;
};

export type SeedVariable = {
	template_key: string;
	variable_name: string;
	is_required: boolean;
	description: string | null;
	example_value: string | null;
};
