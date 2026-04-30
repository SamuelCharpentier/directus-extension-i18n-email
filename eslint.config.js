// Flat ESLint config for TypeScript sources, tests, and Vue interfaces.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import globals from 'globals';

const tsUnusedVarsRule = [
	'error',
	{
		argsIgnorePattern: '^_',
		varsIgnorePattern: '^_',
		caughtErrorsIgnorePattern: '^_',
	},
];

export default tseslint.config(
	{
		ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'examples/**'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['src/**/*.ts', 'tests/**/*.ts'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-unused-vars': tsUnusedVarsRule,
		},
	},
	{
		files: ['tests/**/*.ts'],
		rules: {
			'@typescript-eslint/no-empty-function': 'off',
		},
	},
	// Vue single-file components — `vue-eslint-parser` handles the
	// `<template>` block and delegates `<script lang="ts">` to the
	// TypeScript ESLint parser so type-aware syntax (`as`, generics,
	// satisfies, etc.) is understood.
	...vue.configs['flat/recommended'],
	{
		files: ['src/**/*.vue'],
		languageOptions: {
			parser: vueParser,
			parserOptions: {
				parser: tseslint.parser,
				ecmaVersion: 2022,
				sourceType: 'module',
				extraFileExtensions: ['.vue'],
			},
			globals: {
				...globals.browser,
			},
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-unused-vars': tsUnusedVarsRule,
			// Indent with tabs to match the rest of the codebase.
			'vue/html-indent': ['warn', 'tab'],
			// Stylistic rules we don't enforce — our templates are
			// readable as written and reformatting churn isn't worth it.
			'vue/max-attributes-per-line': 'off',
			'vue/singleline-html-element-content-newline': 'off',
			'vue/html-self-closing': 'off',
			'vue/attributes-order': 'off',
			'vue/html-closing-bracket-newline': 'off',
			'vue/first-attribute-linebreak': 'off',
			// The interfaces use single-word component names (`JsonInterface`,
			// `BodyInterface`, …) which `vue/multi-word-component-names`
			// flags. Disable: these are app-internal, not published as
			// reusable components.
			'vue/multi-word-component-names': 'off',
		},
	},
);
