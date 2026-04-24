import { describe, it, expect, vi } from 'vitest';
import { emptySchema, makeLogger, makeServices } from './helpers';
import { isAdminErrorTemplate, notifyAdmins } from '../src/admin-alert';

describe('isAdminErrorTemplate', () => {
	it('recognizes admin-error', () => {
		expect(isAdminErrorTemplate('admin-error')).toBe(true);
	});

	it('rejects anything else', () => {
		expect(isAdminErrorTemplate('user-invitation')).toBe(false);
		expect(isAdminErrorTemplate(undefined)).toBe(false);
	});
});

describe('notifyAdmins', () => {
	function adminsResolved(emails: string[]) {
		return makeServices({
			items: {
				directus_users: {
					readByQuery: vi.fn().mockResolvedValue(emails.map((email) => ({ email }))),
				},
			},
		});
	}

	it('warns and returns when no admins are found', async () => {
		const { services } = adminsResolved([]);
		const logger = makeLogger();
		await notifyAdmins('reason', { x: 1 }, services, emptySchema, logger);
		expect(logger.warn).toHaveBeenCalled();
	});

	it('dispatches a MailService.send to every admin', async () => {
		const { services, mailInstance } = adminsResolved(['a@x.com', 'b@x.com']);
		const logger = makeLogger();
		await notifyAdmins('reason', { x: 1 }, services, emptySchema, logger);
		expect(mailInstance.send).toHaveBeenCalledOnce();
		const call = mailInstance.send.mock.calls[0]![0];
		expect(call.to).toEqual(['a@x.com', 'b@x.com']);
		expect(call.template.name).toBe('admin-error');
		expect(call.template.data.reason).toBe('reason');
		expect(JSON.parse(call.template.data.context)).toEqual({ x: 1 });
		expect(typeof call.template.data.timestamp).toBe('string');
		expect(logger.info).toHaveBeenCalled();
	});

	it('logs and returns when MailService.send throws', async () => {
		const services = makeServices({
			items: {
				directus_users: {
					readByQuery: vi.fn().mockResolvedValue([{ email: 'a@x.com' }]),
				},
			},
			mail: { send: vi.fn().mockRejectedValue(new Error('smtp down')) },
		});
		const logger = makeLogger();
		await notifyAdmins('r', {}, services.services, emptySchema, logger);
		expect(logger.error).toHaveBeenCalled();
	});

	it('swallows nested re-entry while an outer call is still in flight', async () => {
		// First call will hold the lock while readByQuery is pending; the
		// second call should see notifyInFlight=true and return immediately.
		let release!: (v: { email: string }[]) => void;
		const { services } = makeServices({
			items: {
				directus_users: {
					readByQuery: vi
						.fn()
						.mockImplementation(() => new Promise((res) => (release = res))),
				},
			},
		});
		const logger = makeLogger();
		const first = notifyAdmins('outer', {}, services, emptySchema, logger);
		// Second call runs while first is still awaiting readByQuery.
		await notifyAdmins('inner', {}, services, emptySchema, logger);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('inner'));
		release([{ email: 'a@x.com' }]);
		await first;
	});
});
