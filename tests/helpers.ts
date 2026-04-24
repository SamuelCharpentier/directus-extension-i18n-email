import { vi } from 'vitest';

export function makeLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
}

export type ItemMock = {
	readByQuery: ReturnType<typeof vi.fn>;
	readOne: ReturnType<typeof vi.fn>;
	readMany: ReturnType<typeof vi.fn>;
	createOne: ReturnType<typeof vi.fn>;
};

function fillItemMock(overrides: Partial<ItemMock> = {}): ItemMock {
	return {
		readByQuery: overrides.readByQuery ?? vi.fn().mockResolvedValue([]),
		readOne: overrides.readOne ?? vi.fn().mockResolvedValue(null),
		readMany: overrides.readMany ?? vi.fn().mockResolvedValue([]),
		createOne: overrides.createOne ?? vi.fn().mockResolvedValue('new-id'),
	};
}

/**
 * Build a mock ExtensionsServices-like object using plain constructor
 * functions so `new services.X(...)` works cleanly.
 */
export function makeServices(
	opts: {
		items?: Record<string, Partial<ItemMock>>;
		settings?: { readSingleton?: ReturnType<typeof vi.fn> };
		collections?: {
			readOne?: ReturnType<typeof vi.fn>;
			createOne?: ReturnType<typeof vi.fn>;
		};
		mail?: { send?: ReturnType<typeof vi.fn> };
	} = {},
) {
	const itemsInstances: Record<string, ItemMock> = {};
	for (const [collection, overrides] of Object.entries(opts.items ?? {})) {
		itemsInstances[collection] = fillItemMock(overrides);
	}

	function ItemsService(this: any, collection: string) {
		if (!itemsInstances[collection]) {
			itemsInstances[collection] = fillItemMock();
		}
		return itemsInstances[collection];
	}

	const settingsInstance = {
		readSingleton: opts.settings?.readSingleton ?? vi.fn().mockResolvedValue({}),
	};
	function SettingsService() {
		return settingsInstance;
	}

	const collectionsInstance = {
		readOne: opts.collections?.readOne ?? vi.fn().mockResolvedValue({ collection: 'x' }),
		createOne: opts.collections?.createOne ?? vi.fn().mockResolvedValue('new'),
	};
	function CollectionsService() {
		return collectionsInstance;
	}

	const mailInstance = {
		send: opts.mail?.send ?? vi.fn().mockResolvedValue(undefined),
	};
	function MailService() {
		return mailInstance;
	}

	return {
		services: {
			ItemsService: ItemsService as any,
			SettingsService: SettingsService as any,
			CollectionsService: CollectionsService as any,
			MailService: MailService as any,
		} as any,
		itemsInstances,
		settingsInstance,
		collectionsInstance,
		mailInstance,
	};
}

export const emptySchema = {} as any;
