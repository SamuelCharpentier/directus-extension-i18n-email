import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			// `src/interface/**` is app-side code that requires the Directus runtime
			// (Vue, the in-app theme, the form-injected `values` ref, and SFC tooling).
			// We have a smoke test that imports the entry to validate its config shape,
			// but v8 coverage cannot trace the SDK's `defineInterface` wrapper reliably,
			// so we exclude the folder rather than chasing flaky coverage numbers.
			exclude: ['src/types.ts', 'src/interface/**'],
			reporter: ['text', 'html'],
			thresholds: {
				statements: 99,
				branches: 95,
				functions: 100,
				lines: 100,
			},
		},
	},
});
