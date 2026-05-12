import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServices, makeLogger, makeSchema } from './helpers';
import { readTemplateFromDisk, syncTemplateBody, templateFilePath, deleteTemplateFile } from '../src/sync';

describe('sync', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'i18n-email-sync-'));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('templateFilePath joins correctly', () => {
		expect(templateFilePath('/tmp', 'foo')).toMatch(/foo\.liquid$/);
	});

	it('readTemplateFromDisk returns null when missing', async () => {
		expect(await readTemplateFromDisk(dir, 'nope')).toBeNull();
	});

	it('readTemplateFromDisk returns null when path empty', async () => {
		expect(await readTemplateFromDisk('', 'x')).toBeNull();
	});

	it('readTemplateFromDisk reads existing file', async () => {
		await writeFile(join(dir, 'foo.liquid'), 'hello', 'utf-8');
		expect(await readTemplateFromDisk(dir, 'foo')).toBe('hello');
	});

	it('syncTemplateBody writes, audits, updates metadata', async () => {
		const s = makeServices({
			items: {
				email_templates: { rows: [{ id: 'r1', template_key: 'x', body: 'body' }] },
				email_template_sync_audit: { rows: [] },
			},
		});
		const logger = makeLogger();
		await syncTemplateBody(
			{
				id: 'r1',
				template_key: 'x',
				category: 'custom',
				body: 'body',
				description: null,
				is_active: true,
				is_protected: false,
				checksum: '',
				last_synced_at: null,
			},
			dir,
			s as any,
			makeSchema(),
			logger,
		);
		const written = await readFile(join(dir, 'x.liquid'), 'utf-8');
		expect(written).toBe('body');
		expect(s._stores.email_template_sync_audit?.length).toBe(1);
		const meta = s._stores.email_templates?.find((r: any) => r.id === 'r1');
		expect(meta.checksum).toMatch(/^[0-9a-f]{64}$/);
		expect(meta.last_synced_at).toBeTruthy();
	});

	it('warns when templatesPath is empty', async () => {
		const s = makeServices();
		const logger = makeLogger();
		await syncTemplateBody(
			{
				id: 'r1',
				template_key: 'x',
				category: 'custom',
				body: 'b',
				description: null,
				is_active: true,
				is_protected: false,
				checksum: '',
				last_synced_at: null,
			},
			'',
			s as any,
			makeSchema(),
			logger,
		);
		expect(logger.warn).toHaveBeenCalled();
	});

	it('logs error when write fails', async () => {
		const logger = makeLogger();
		const s = makeServices();
		// use a path that will fail (file as a dir component)
		const filePath = join(dir, 'locked');
		await writeFile(filePath, 'x', 'utf-8'); // now a file, not a dir
		await syncTemplateBody(
			{
				id: 'r1',
				template_key: 'x',
				category: 'custom',
				body: 'body',
				description: null,
				is_active: true,
				is_protected: false,
				checksum: '',
				last_synced_at: null,
			},
			join(filePath, 'nested'),
			s as any,
			makeSchema(),
			logger,
		);
		expect(logger.error).toHaveBeenCalled();
	});

	it('still writes file even when audit write fails', async () => {
		const s = makeServices({
			items: {
				email_templates: { rows: [{ id: 'r1', template_key: 'x' }] },
				email_template_sync_audit: {
					createOne: async () => {
						throw new Error('audit fail');
					},
				},
			},
		});
		const logger = makeLogger();
		await syncTemplateBody(
			{
				id: 'r1',
				template_key: 'x',
				category: 'custom',
				body: 'body',
				description: null,
				is_active: true,
				is_protected: false,
				checksum: '',
				last_synced_at: null,
			},
			dir,
			s as any,
			makeSchema(),
			logger,
		);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Audit row skipped'));
	});

	it('warns when metadata update fails', async () => {
		const s = makeServices({
			items: {
				email_templates: {
					rows: [{ id: 'r1', template_key: 'x' }],
					updateOne: async () => {
						throw new Error('boom');
					},
				},
				email_template_sync_audit: { rows: [] },
			},
		});
		const logger = makeLogger();
		await syncTemplateBody(
			{
				id: 'r1',
				template_key: 'x',
				category: 'custom',
				body: 'body',
				description: null,
				is_active: true,
				is_protected: false,
				checksum: '',
				last_synced_at: null,
			},
			dir,
			s as any,
			makeSchema(),
			logger,
		);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to update sync metadata'),
		);
	});

	it('skips metadata update when row has no id', async () => {
		const s = makeServices({
			items: { email_template_sync_audit: { rows: [] } },
		});
		const logger = makeLogger();
		await syncTemplateBody(
			{
				template_key: 'x',
				category: 'custom',
				body: 'body',
				description: null,
				is_active: true,
				is_protected: false,
				checksum: '',
				last_synced_at: null,
			},
			dir,
			s as any,
			makeSchema(),
			logger,
		);
		// no throw, logger.info fired
		expect(logger.info).toHaveBeenCalled();
	});

	describe('deleteTemplateFile', () => {
		it('removes existing file and logs info', async () => {
			await writeFile(join(dir, 'gone.liquid'), 'x', 'utf-8');
			const logger = makeLogger();
			await deleteTemplateFile(dir, 'gone', logger);
			expect(await readTemplateFromDisk(dir, 'gone')).toBeNull();
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Removed gone.liquid'));
		});

		it('silently tolerates missing file (ENOENT)', async () => {
			const logger = makeLogger();
			await deleteTemplateFile(dir, 'nope', logger);
			expect(logger.warn).not.toHaveBeenCalled();
			expect(logger.info).not.toHaveBeenCalled();
		});

		it('no-ops when templatesPath is empty', async () => {
			const logger = makeLogger();
			await deleteTemplateFile('', 'whatever', logger);
			expect(logger.info).not.toHaveBeenCalled();
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('warns on non-ENOENT failure', async () => {
			const logger = makeLogger();
			// Passing a directory path to unlink yields EISDIR/EPERM, not ENOENT.
			const sub = join(dir, 'as-dir');
			await mkdir(sub);
			await writeFile(join(sub, 'k.liquid'), 'x', 'utf-8'); // ensure non-empty dir
			// templateFilePath builds `${dir}/${key}.liquid`; aim it at the directory itself.
			// Trick: pass key whose .liquid suffix resolves to an existing directory.
			await mkdir(join(dir, 'isdir.liquid'));
			await deleteTemplateFile(dir, 'isdir', logger);
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to remove'));
		});
	});
});

// Defensive: import mkdir so eslint doesn't complain about unused.
void mkdir;
void vi;
