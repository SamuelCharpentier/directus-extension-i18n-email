import { describe, it, expect, vi } from 'vitest';
import { renderLiquidString, renderLiquidStrings } from '../src/liquid';

const mkLogger = () => ({ warn: vi.fn() });

describe('renderLiquidString', () => {
	it('returns plain text untouched without a Liquid token', async () => {
		const out = await renderLiquidString('Hello world', { a: 1 }, mkLogger(), 'plain');
		expect(out).toBe('Hello world');
	});

	it('returns empty string as-is', async () => {
		const out = await renderLiquidString('', {}, mkLogger(), 'empty');
		expect(out).toBe('');
	});

	it('interpolates simple variables', async () => {
		const out = await renderLiquidString(
			'Hello {{ user.first_name }}',
			{ user: { first_name: 'Sam' } },
			mkLogger(),
			'greet',
		);
		expect(out).toBe('Hello Sam');
	});

	it('renders string with `{%` tag (filter test branch)', async () => {
		const out = await renderLiquidString(
			'{% if show %}yes{% else %}no{% endif %}',
			{ show: true },
			mkLogger(),
			'tag',
		);
		expect(out).toBe('yes');
	});

	it('returns missing variable as empty (lax lookup)', async () => {
		const out = await renderLiquidString(
			'Hi {{ user.first_name }}',
			{},
			mkLogger(),
			'missing',
		);
		expect(out).toBe('Hi ');
	});

	it('falls back to raw string and warns on parse error', async () => {
		const logger = mkLogger();
		const raw = '{% bogus %}';
		const out = await renderLiquidString(raw, {}, logger, 'bad');
		expect(out).toBe(raw);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Liquid render failed'));
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bad'));
	});
});

describe('renderLiquidStrings', () => {
	it('renders each value in the map, preserving keys', async () => {
		const out = await renderLiquidStrings(
			{
				heading: 'Hi {{ user.first_name }}',
				footer: 'plain text',
			},
			{ user: { first_name: 'Al' } },
			mkLogger(),
			'tpl',
		);
		expect(out).toEqual({ heading: 'Hi Al', footer: 'plain text' });
	});

	it('isolates per-key failures', async () => {
		const logger = mkLogger();
		const out = await renderLiquidStrings(
			{
				good: 'Hi {{ user.first_name }}',
				bad: '{% bogus %}',
			},
			{ user: { first_name: 'Al' } },
			logger,
			'tpl',
		);
		expect(out.good).toBe('Hi Al');
		expect(out.bad).toBe('{% bogus %}');
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tpl.bad'));
	});

	it('handles empty map', async () => {
		const out = await renderLiquidStrings({}, {}, mkLogger(), 'tpl');
		expect(out).toEqual({});
	});
});
