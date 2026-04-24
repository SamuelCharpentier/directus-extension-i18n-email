import type { ExtensionsServices, SchemaOverview } from '@directus/types';
import type { Logger } from './types';
import { ADMIN_ERROR_KEY } from './constants';
import { fetchAdminEmails } from './directus';

let notifyInFlight = false;

/**
 * Notify all active admin users via email when a send fails. Uses the
 * admin-error template so the i18n filter translates it to each admin's
 * language just like any other system email.
 *
 * Recursion guard: if this function is somehow re-entered while
 * already running, the nested call is swallowed. This prevents a
 * runaway loop if the admin-error send itself fails.
 */
export async function notifyAdmins(
	reason: string,
	context: Record<string, unknown>,
	services: ExtensionsServices,
	schema: SchemaOverview,
	logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<void> {
	if (notifyInFlight) {
		logger.warn(`[i18n-email] notifyAdmins re-entered, swallowing: ${reason}`);
		return;
	}
	notifyInFlight = true;
	try {
		const admins = await fetchAdminEmails(services, schema);
		if (admins.length === 0) {
			logger.warn(`[i18n-email] notifyAdmins: no admin recipients found. reason=${reason}`);
			return;
		}
		const mail = new services.MailService({ schema, accountability: null });
		await mail.send({
			to: admins,
			template: {
				name: ADMIN_ERROR_KEY,
				data: {
					reason,
					context: JSON.stringify(context, null, 2),
					timestamp: new Date().toISOString(),
				},
			},
		});
		logger.info(`[i18n-email] notifyAdmins dispatched to ${admins.length} admin(s): ${reason}`);
	} catch (err) {
		logger.error(
			`[i18n-email] notifyAdmins failed while sending admin-error email: ${(err as Error).message}`,
		);
	} finally {
		notifyInFlight = false;
	}
}

/**
 * Predicate used by the send filter to short-circuit when the email
 * currently being processed IS the admin-error notification itself.
 */
export function isAdminErrorTemplate(templateName: string | undefined): boolean {
	return templateName === ADMIN_ERROR_KEY;
}
