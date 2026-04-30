import { describe, it, expect, vi } from 'vitest';

// Mock the .vue SFC import so Vitest can resolve it without @vitejs/plugin-vue.
vi.mock('../src/interface/Interface.vue', () => ({
	default: { name: 'I18nStringsEditorInterface' },
}));

import interfaceConfig from '../src/interface/index';

describe('interface entry', () => {
	it('exports a defineInterface config with expected shape', () => {
		const config = interfaceConfig as unknown as Record<string, unknown>;

		expect(config.id).toBe('i18n-strings-editor');
		expect(config.icon).toBe('translate');
		expect(typeof config.name).toBe('string');
		expect(typeof config.description).toBe('string');
		expect(Array.isArray(config.types)).toBe(true);
		expect((config.types as string[]).includes('json')).toBe(true);
		expect(config.component).toBeTruthy();

		const options = config.options as Array<{ field: string; meta?: { interface?: string } }>;
		expect(Array.isArray(options)).toBe(true);
		const variant = options.find((o) => o.field === 'variant');
		expect(variant).toBeTruthy();
		expect(variant?.meta?.interface).toBe('select-dropdown');
	});
});
