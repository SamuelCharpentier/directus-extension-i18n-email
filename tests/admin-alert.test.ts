import { describe, it, expect, beforeEach } from 'vitest';
import { makeServices, makeLogger, makeSchema } from './helpers';
import { notifyAdmins } from '../src/admin-alert';

describe('notifyAdmins', () => {
	let logger: ReturnType<typeof makeLogger>;
	beforeEach(() => {
		logger = makeLogger();
	});

	it('sends admin-error email to admin users', async () => {
		const s = makeServices({
			items: {
				directus_users: {
					readByQuery: async () => [{ email: 'admin@x.co' }],
				},
			},
		});
		await notifyAdmins('boom', { a: 1 }, s as any, makeSchema(), logger);
		expect(s._mailSends.length).toBe(1);
		expect(s._mailSends[0].template.name).toBe('admin-error');
		expect(s._mailSends[0].to).toEqual(['admin@x.co']);
		// Stamped so the filter passes it through untouched — it can
		// never fail validation and never trigger a nested alert.
		expect(s._mailSends[0].template.data._i18nSkipProcessing).toBe(true);
		expect(logger.info).toHaveBeenCalled();
	});

	it('warns when no admins', async () => {
		const s = makeServices({
			items: { directus_users: { readByQuery: async () => [] } },
		});
		await notifyAdmins('boom', {}, s as any, makeSchema(), logger);
		expect(logger.warn).toHaveBeenCalled();
		expect(s._mailSends.length).toBe(0);
	});

	it('logs error when MailService throws', async () => {
		const s = makeServices({
			items: { directus_users: { readByQuery: async () => [{ email: 'a@x.co' }] } },
			mail: {
				send: async () => {
					throw new Error('smtp down');
				},
			},
		});
		await notifyAdmins('x', {}, s as any, makeSchema(), logger);
		expect(logger.error).toHaveBeenCalled();
	});

	it('is re-entry safe', async () => {
		let inside = false;
		const s = makeServices({
			items: { directus_users: { readByQuery: async () => [{ email: 'a@x.co' }] } },
			mail: {
				send: async () => {
					if (!inside) {
						inside = true;
						// re-entrant call while first is in-flight
						await notifyAdmins('nested', {}, s as any, makeSchema(), logger);
					}
					return { messageId: 'ok' };
				},
			},
		});
		await notifyAdmins('outer', {}, s as any, makeSchema(), logger);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('re-entered'));
	});
});
