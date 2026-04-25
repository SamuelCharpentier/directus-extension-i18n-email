import { describe, it, expect } from 'vitest';
import { computeChecksum } from '../src/integrity';

describe('computeChecksum', () => {
	it('is stable for the same body', () => {
		expect(computeChecksum({ body: 'hi' })).toBe(computeChecksum({ body: 'hi' }));
	});
	it('differs when body differs', () => {
		expect(computeChecksum({ body: 'a' })).not.toBe(computeChecksum({ body: 'b' }));
	});
	it('returns a 64-char hex string', () => {
		expect(computeChecksum({ body: 'x' })).toMatch(/^[0-9a-f]{64}$/);
	});
});
