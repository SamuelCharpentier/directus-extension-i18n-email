import type { ExtensionsServices, SchemaOverview } from '@directus/types';
import { fetchTemplateVariables } from './directus';
import type { EmailTemplateVariableRow } from './types';

/**
 * Detects whether the given Liquid template source includes a default
 * filter for a variable (e.g. `{{ foo | default: "x" }}`). Variables
 * that have an inline default are tolerated when missing from
 * template.data; others are enforced by the registry.
 *
 * This intentionally uses a simple regex rather than parsing Liquid —
 * it errs on the side of LENIENCY (accepts a default when in doubt) so
 * template authors can opt out of strict enforcement by adding one.
 */
export function hasLiquidDefault(source: string, variable: string): boolean {
	const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// Matches: {{ variable | default: ... }} — whitespace flexible
	const pattern = new RegExp(
		`\\{\\{\\s*${escaped}\\s*(?:\\|[^}]*\\bdefault\\s*:[^}]*)\\}\\}`,
		'i',
	);
	return pattern.test(source);
}

/**
 * Result of a required-variable validation pass.
 */
export type ValidationResult = { ok: true } | { ok: false; missing: string[] };

/**
 * Validate that every required variable for the given template_key is
 * present in the caller's template.data payload. A variable declared
 * as required is tolerated only if:
 *   - it is a key on data (any value, including empty string), OR
 *   - its name is guarded by a Liquid `| default:` filter anywhere in
 *     the provided liquidSource (optional sniff).
 */
export async function validateRequiredVariables(
	templateKey: string,
	data: Record<string, unknown>,
	services: ExtensionsServices,
	schema: SchemaOverview,
	liquidSource?: string,
): Promise<ValidationResult> {
	const registry = await fetchTemplateVariables(templateKey, services, schema);
	const required = registry.filter(
		(r): r is EmailTemplateVariableRow & { is_required: true } => r.is_required === true,
	);
	const missing: string[] = [];
	for (const row of required) {
		if (row.variable_name in data) continue;
		if (liquidSource && hasLiquidDefault(liquidSource, row.variable_name)) continue;
		missing.push(row.variable_name);
	}
	if (missing.length === 0) return { ok: true };
	return { ok: false, missing };
}
