# Directus i18n Email Extension

Database-backed, multilingual transactional email for Directus. You will be able to translate system emails (password reset, user invitation, user registration) into every language you need to support — and ship your own transactional templates the same way.

- **DB is the source of truth.** Each email lives as a single `email_templates` row whose Liquid `body` is the template; translatable copy (subject, from-name, i18n strings) lives in `email_template_translations`, one row per language, edited through Directus's native translations interface.
- **Liquid everywhere translatable.** Subject, from-name, and every value inside the i18n variables map are Liquid-rendered against the same data context as the body — so translators can write `{{ user.first_name }}` (or any caller-supplied variable) directly inside a translated string or subject line, where word order varies by language.
- **Body is mirrored to disk.** Whenever a `body` is created or updated, the extension writes `EMAIL_TEMPLATES_PATH/<template_key>.liquid` so Directus's `MailService` can render it. Translations stay in the DB — no `.json` locale files.
- **Auto-reconciled i18n variables.** Every `email_template_translations.i18n_variables` row keeps a `{ in_template, unused }` split. Keys referenced by the body (`{{ i18n.foo }}`) are extracted automatically on create/update and on user-driven refreshes; keys you remove from the body are demoted to `unused` (kept for re-use), never silently deleted.
- **Custom editor interfaces.** The bundle ships three Vue interfaces wired to the schema by default: a body editor that emits blur events, a translations wrapper with a refresh button + per-user auto-refresh toggle, and a two-section variables editor (In template / Unused) with a JSON fallback view.
- **Idempotent bootstrap.** Required collections, relations, field meta, languages, system templates, and the variable registry are created or migrated on every boot. Existing rows are never overwritten.
- **Variable registry.** Declare required variables per template; missing variables abort the send and notify admins.
- **Admin alerting.** Any dispatch failure sends an `admin-error` email to every active admin-role user.
- **Safe by default.** Unknown template names pass through untouched, so existing raw Directus templates keep working.

<br />

---

<br />

## Table of Contents

- [Install](#install)
- [First Boot](#first-boot)
- [How It Works](#how-it-works)
- [Environment Variables](#environment-variables)
- [Directory Layout](#directory-layout)
- [Collections](#collections)
- [Liquid Templates](#liquid-templates)
- [Editor Interfaces](#editor-interfaces)
- [Sending Custom Emails](#sending-custom-emails)
- [Language Resolution](#language-resolution)
- [Admin Error Notifications](#admin-error-notifications)
- [Development](#development)
- [Notes](#notes)
- [Contributing](#contributing)

---

## Install

### Manual build and install

```sh
npm ci && npm run build
```

Create a folder named `directus-extension-i18n-email` inside your Directus project's extensions folder (typically `<directus-project>/extensions`; see `EXTENSIONS_PATH` in your Directus environement variables) and copy both `dist/` and `package.json` into it. Directus reads the extension entry point from `package.json`'s `directus:extension` field, so both must be present alongside each other. Restart Directus afterwards.

### Symlink (local development)

Symlink this repo into it for local development:

```sh
npm run link -- "absolute/path/to/directus/extensions/folder"
```

`npm run link` wraps `directus-extension link <extensions-folder>` from `@directus/extensions-sdk`. It creates a symlink at `<extensions-folder>/directus-extension-i18n-email` pointing back at this repo, so changes to `dist/` are picked up without copying. Run `npm run build` (or keep `npm run dev` watching) so `dist/index.js` exists, then restart Directus.

See the [official installation guide](https://docs.directus.io/extensions/installing-extensions.html) for other options.

## First Boot

On first start the extension will:

1. Create the `languages`, `email_templates`, `email_template_translations`, `email_template_variables`, `email_template_sync_audit`, and `email_extension_user_prefs` collections (and the relations between them) if missing.
2. Seed the `languages` collection from your project's default language (`directus_settings.default_language`). If the default isn't `en-US`, an `en-US` row is also seeded so the suggested English copy has a home. Each row's `name` is auto-populated from `code` via `Intl.DisplayNames` (e.g. `fr-FR` → "French (France)") and used as the tab label in the translations interface. If `languages` is already populated, bootstrap leaves it alone.
3. Seed protected system templates (`base`, `password-reset`, `user-invitation`, `user-registration`, `admin-error`) — one `email_templates` row each, then one `email_template_translations` row per template per seeded language: an empty placeholder for the project's default language, plus the English suggested copy when that default isn't `en-US`.
4. Seed required-variable entries in `email_template_variables` for the system templates.
5. Write each template body to `EMAIL_TEMPLATES_PATH/<template_key>.liquid`. If a `.liquid` file already exists on disk for a key with no DB row yet, the disk contents take precedence over the shipped default (preserves admin edits from earlier filesystem-based installs).

The bootstrap also runs a graceful field/relation migration on every boot — it upserts field meta and relation meta against the schema definitions in this extension, but never alters column types or drops fields.

<br />

---

<br />

## How It Works

The extension registers an `email.send` filter. For every outgoing email:

1. Resolves the recipient's language (full BCP-47): `directus_users.language` of the recipient → `directus_settings.default_language` → `I18N_EMAIL_FALLBACK_LANG` → `en-US`.
2. Fetches the active `email_templates` row for `template_key = template.name` plus its `email_template_translations` row for the effective language. Falls back to the default-language translation when the effective-language row is missing or is the empty-placeholder shape (blank subject AND empty/null `i18n_variables.in_template`).
3. Validates required variables from `email_template_variables`. Missing variables abort the send and trigger an admin notification.
4. Pre-renders the translation's `subject`, `from_name`, and every value in its `i18n_variables.in_template` map through Liquid using the same data context the body will see. Only the `in_template` half is sent — `unused` entries are kept in the DB for re-use but never reach the recipient.
5. Also resolves the `base` template's translation for the same language and exposes its rendered `in_template` strings as `i18n.base.*` (shared layout copy).
6. For protected system templates, hydrates the recipient as `user` from `directus_users` (when not already provided in `template.data`).
7. Injects the rendered values into the email: `subject`, `from_name`, and `template.data.i18n.*`.

Templates whose `template.name` doesn't match any active DB row pass through untouched — Directus's native renderer handles them.

### Variable reconciliation

Whenever an `email_templates.body` is created or updated, the extension parses the body for `{{ i18n.<key> }}` references and reconciles every related `email_template_translations.i18n_variables` row:

- Keys newly referenced by the body are added to `in_template` (with empty string values you fill in via the editor).
- Keys removed from the body are moved from `in_template` to `unused`. Their values are preserved verbatim — re-add the key to the body and its previous translation reappears.
- Keys you re-add to the body are promoted from `unused` back to `in_template`, again preserving values.

This means the variables editor is always in sync with what the template actually uses, without you having to bookkeep keys by hand. The custom interfaces (see [Editor Interfaces](#editor-interfaces)) trigger the same reconcile on demand from the form.

Whenever an `email_templates` row is created or its `body` / `template_key` is updated, the extension re-writes `<template_key>.liquid` atomically and appends to `email_template_sync_audit`.

<br />

---

<br />

## Environment Variables

The standard Directus email variables apply (see [Directus email config](https://docs.directus.io/configuration/email.html)):

| Variable               | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `EMAIL_TEMPLATES_PATH` | Path where `.liquid` templates live. Default: `./templates`. |
| `EMAIL_FROM`           | Envelope `from` address. Used as the fallback sender.        |

Extension-specific:

| Variable                        | Default | Description                                                                                                  |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `I18N_EMAIL_FALLBACK_LANG`      | `en-US` | BCP-47 language tag used when `directus_settings.default_language` is null.                                  |
| `I18N_EMAIL_FALLBACK_FROM_NAME` | —       | Display name used when a translation row has no `from_name`. Falls back to `directus_settings.project_name`. |

<br />

---

<br />

## Directory Layout

```
EMAIL_TEMPLATES_PATH/
├── base.liquid                 — shared layout (referenced via {% layout "base" %})
├── password-reset.liquid
├── user-invitation.liquid
├── user-registration.liquid
└── admin-error.liquid          — internal: sent to admins on dispatch failure
```

The `.liquid` files in this directory are managed by this extension — they are written from `email_templates.body` whenever a row is created or its body is updated. Translations (subject, from-name, i18n strings) live exclusively in the DB; there are no on-disk locale files.

You can copy the files under [examples/templates/](examples/templates) into `EMAIL_TEMPLATES_PATH` _before_ the first boot to use them as the seeded body for matching `template_key`s — bootstrap will pick them up in preference to the shipped defaults.

<br />

---

<br />

## Collections

### `languages`

Two-field collection used as the FK target for `email_template_translations.languages_code`.

| Field  | Type   | Notes                                                                                                                            |
| ------ | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `code` | string | PK, BCP-47 (`en-US`, `fr-FR`, …). Uses Directus's built-in `system-language` interface.                                          |
| `name` | string | Auto-populated from `code` via `Intl.DisplayNames` on insert. Used as the translations interface tab label. Read-only in the UI. |

### `email_templates`

One row per template (language-agnostic).

| Field            | Type    | Notes                                                                                                  |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `id`             | uuid    | PK                                                                                                     |
| `template_key`   | string  | Unique. e.g. `password-reset`, `base`, or your custom key.                                             |
| `category`       | enum    | `system` \| `layout` \| `transactional` \| `marketing` \| `custom`                                     |
| `body`           | text    | Full Liquid template (e.g. `{% layout "base" %}{% block content %}…{% endblock %}`). Mirrored to disk. |
| `translations`   | alias   | o2m → `email_template_translations`. Renders as the translations interface.                            |
| `description`    | text?   | Admin-facing explanation                                                                               |
| `is_active`      | boolean | Disable without deleting (also drives the archive toggle)                                              |
| `is_protected`   | boolean | Protected rows cannot be deleted (system templates + `base` + `admin-error`)                           |
| `checksum`       | string  | SHA-256 of `body` — maintained by the create/update filter                                             |
| `last_synced_at` | ts?     | Last successful filesystem sync                                                                        |
| `created_at`     | ts      | Auto                                                                                                   |
| `updated_at`     | ts      | Auto                                                                                                   |

### `email_template_translations`

One row per `(email_templates_id, languages_code)` pair, edited through the parent's translations interface.

| Field                | Type    | Notes                                                                                           |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `id`                 | uuid    | PK                                                                                              |
| `email_templates_id` | uuid    | FK → `email_templates.id` (cascade delete)                                                      |
| `languages_code`     | string  | FK → `languages.code` (cascade delete)                                                          |
| `subject`            | string? | Email subject. Empty for the `base` layout. Liquid-rendered before send.                                                                                                                                                          |
| `from_name`          | string? | Sender display-name override for this language. Liquid-rendered before send.                                                                                                                                                      |
| `i18n_variables`     | json    | `{ in_template: { [key]: string }, unused: { [key]: string } }`. `in_template` values are Liquid-rendered and exposed to the body as `{{ i18n.* }}`; `unused` values are kept in the DB for re-use but never sent to recipients. |

### `email_template_variables`

Declare what each template needs. If a variable is `is_required` and missing from `template.data` at send time, the dispatch aborts and admins are notified.

| Field           | Type    | Notes                                                 |
| --------------- | ------- | ----------------------------------------------------- |
| `id`            | uuid    | PK                                                    |
| `template_key`  | string  | Matches `email_templates.template_key` by convention  |
| `variable_name` | string  | e.g. `url`, `projectName`                             |
| `is_required`   | boolean | Aborts send when missing                              |
| `is_protected`  | boolean | Auto-set for entries belonging to protected templates |
| `description`   | text?   | Admin-facing                                          |
| `example_value` | string? | Shown in docs / preview                               |

### `email_template_sync_audit`

Append-only log of body filesystem syncs. Written by the extension; readable by admins for debugging.

| Field          | Type    | Notes                                        |
| -------------- | ------- | -------------------------------------------- |
| `id`           | uuid    | PK                                           |
| `template_key` | string  | Which template the row covers                |
| `reason`       | string? | `bootstrap`, `body-create`, `body-update`, … |
| `action`       | string? | `body-write`, …                              |
| `created_at`   | ts      | Auto                                         |

### `email_extension_user_prefs`

Per-user UI preferences for the editor interfaces. Hidden from the navigation sidebar; rows are created lazily by the translations interface the first time a user toggles a preference. PK is the user's uuid (no FK relation — the row outlives user deletions and is harmless if orphaned).

| Field                                | Type    | Notes                                                                                                            |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `user`                               | uuid    | PK. Matches `directus_users.id`.                                                                                 |
| `auto_refresh_i18n_on_body_change`   | boolean | When checked, the translations interface reconciles every language's `i18n_variables` on every body blur event. |

<br />

---

<br />

## Liquid Templates

Templates are yours to design. Inside a template body you have access to:

| Variable            | Source                                      | Description                                                   |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `{{ i18n.* }}`      | The active translation row's `i18n_variables.in_template`      | Any key from the translation's JSON payload                   |
| `{{ i18n.base.* }}` | The `base` template's translation `i18n_variables.in_template` | Shared layout strings (footer, org name, etc.)                |
| `{{ url }}`         | Directus                                    | Action URL for system emails (reset link, invitation link, …) |
| `{{ projectName }}` | Directus                                    | `directus_settings.project_name`                              |
| `{{ user.* }}`      | Recipient lookup (system templates only)    | `id`, `first_name`, `last_name`, `email`, `language`          |
| _other_             | Your caller                                 | Anything you passed in `template.data`                        |

### Liquid in translation fields

Translation `subject`, `from_name`, and every value inside `i18n_variables.in_template` are themselves Liquid-rendered against the same data context the body sees (minus `i18n` itself — translations can't reference themselves). This applies equally to all three fields, so any of these work:

| Field in `email_template_translations`  | Example value                   | Renders to      |
| --------------------------------------- | ------------------------------- | --------------- |
| `subject`                               | `Bonjour {{ user.first_name }}` | `Bonjour Marie` |
| `from_name`                             | `{{ projectName }} Support`     | `Acme Support`  |
| `i18n_variables.in_template.greeting`   | `Hello, {{ user.first_name }}!` | `Hello, John!`  |

The rendered `subject` overrides the email's subject; the rendered `from_name` overrides the sender display-name; rendered `in_template` strings are exposed to the body as `{{ i18n.* }}`. Entries under `i18n_variables.unused` are not rendered and not sent — they're a holding area for keys removed from the body. If a value contains no Liquid tokens it's used as-is. If Liquid parsing fails for a value, the raw string is used and a warning is logged — a bad translation never aborts the send.

### Minimal example

```liquid
{% layout "base" %}
{% block content %}
  <h1>{{ i18n.heading }}</h1>
  <p>{{ i18n.body }}</p>
  <a href="{{ url }}">{{ i18n.cta }}</a>
  <p><small>{{ i18n.expiry_notice }}</small></p>
{% endblock %}
```

See [examples/templates/](examples/templates) for the full set, including [admin-error.liquid](examples/templates/admin-error.liquid) and [base.liquid](examples/templates/base.liquid).

<br />

---

<br />

## Editor Interfaces

This extension is a Directus **bundle** that ships a hook *and* three Vue interfaces. The interfaces are wired to the schema by default during bootstrap so you don't need to pick them manually — but you can swap them out per-field in **Settings → Data Model** if you'd rather use the stock interfaces.

| Interface ID                | Field it powers                                  | What it adds                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body-i18n-aware`           | `email_templates.body`                           | Drop-in replacement for `input-code`. Identical behaviour, plus dispatches a `i18n-email:body-blur` window event with the live body on focus-out so the variables editor can reconcile without leaving the form.                     |
| `translations-i18n-aware`   | `email_templates.translations`                   | Drop-in wrapper around the standard `translations` interface. Adds a **Refresh i18n variables from body** button and an **Auto on body blur** checkbox above the split-view editor. The auto-refresh toggle persists per Directus user via `email_extension_user_prefs.auto_refresh_i18n_on_body_change`. |
| `i18n-strings-editor`       | `email_template_translations.i18n_variables`     | Two-section editor (**In template** / **Unused**) with one auto-growing textarea per key, plus a **Form ⇄ JSON** view toggle. Reclassification between sections happens automatically when the translations interface broadcasts a refresh.                  |

### How the interfaces talk to each other

The three interfaces communicate over a window event bus rather than props/injection so lazily-mounted language tabs can join in:

```
body-i18n-aware           translations-i18n-aware                i18n-strings-editor (×N)
──────────────            ───────────────────────                ───────────────────────
focus-out                 ▶ extracts `{{ i18n.* }}` keys         ▶ subscribes & reclassifies
"i18n-email:body-blur" ──▶ from latest body                      keys into in_template / unused
                          ▶ writes UI-only payload to every      (writes nothing on its own —
                            translation row's i18n_variables       persisted by the parent form)
                          ▶ broadcasts "i18n-email:reconcile-keys"
```

The **Refresh** button does the same dance synchronously without needing a blur event; the **Auto on body blur** checkbox simply toggles whether body-blur events trigger the dispatcher. Reconciliation is UI-only — nothing is saved until you click the standard **Save** button at the top of the form, so you can dismiss unwanted reclassifications by reverting the form.

### Debug logging

The interfaces emit `console.log` traces gated by a localStorage flag. Toggle in DevTools and reload:

```js
localStorage.setItem('i18n-email:debug', '1');   // enable
localStorage.removeItem('i18n-email:debug');     // disable
```

`console.warn` and `console.error` are always on regardless of the flag.

<br />

---

<br />

## Sending Custom Emails

Use the standard Directus `MailService` from your own extensions — this extension intercepts every send:

```ts
const mail = new services.MailService({ schema, accountability: null });

await mail.send({
	to: 'user@example.com',
	subject: 'fallback subject', // overridden by the translation row
	template: {
		name: 'order-shipped', // must match email_templates.template_key
		data: {
			url: 'https://shop.example.com/orders/42',
			trackingNumber: 'ABC123',
		},
	},
});
```

To wire up a new template:

1. Create a single `email_templates` row with `template_key = 'order-shipped'`, set its `body` to your Liquid template, and `is_active = true`.
2. Open the translations interface on that row and add one translation per language (subject, from-name, strings).
3. Declare each required variable in `email_template_variables` for `template_key = 'order-shipped'`.

The body file at `EMAIL_TEMPLATES_PATH/order-shipped.liquid` is created automatically. If no DB row exists for the `template.name` you pass, Directus's native Liquid renderer handles the email unchanged.

<br />

---

<br />

## Language Resolution

For each outgoing email, the effective language is the first non-null of:

1. **User language** — `directus_users.language` of the recipient (full BCP-47, e.g. `fr-CA`).
2. **Project default** — `directus_settings.default_language` (full BCP-47).
3. **`I18N_EMAIL_FALLBACK_LANG`** — used when the project default is null.
4. **`en-US`** — hard-coded last resort.

Codes are kept as full BCP-47 — no region-stripping. If the translation row for `(template, effectiveLang)` is missing, or is the empty-placeholder shape (blank subject AND empty `i18n_variables.in_template`), the extension retries with `(template, defaultLang)`. If that also misses, the email passes through with no i18n injection.

<br />

---

<br />

## Admin Error Notifications

When the extension cannot dispatch an email (missing required variable, DB error, etc.) it sends an `admin-error` email to every active admin-role user. The template is seeded with an empty placeholder for the project's default language plus an English suggested copy when that default isn't `en-US`. It receives:

- `reason` — human-readable failure summary
- `timestamp` — ISO timestamp
- `context` — JSON-stringified context (template key, language, missing variables, recipient)

The extension never re-intercepts an outgoing `admin-error` send, preventing infinite loops if admin delivery itself fails.

<br />

---

<br />

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run verify      # typecheck + lint
npm test            # verify + vitest (with 100% coverage gate)
npm run build       # test + directus-extension build
npm run dev         # watch build (no verify/test gate)
npm run link -- <extensions-folder>   # symlink this repo into a Directus project's extensions folder
```

Coverage thresholds are set to 100% on statements, branches, functions, and lines.

<br />

---

<br />

## Notes

### UI strings are separate

This extension translates **email content only**. Directus admin UI strings (e.g. the "password reset sent" confirmation on the login page) are handled by the Directus frontend i18n system and are not affected here. Override those via **Settings → Translations** in the Data Studio.

### Unknown templates pass through

Sending an email with a `template.name` that has no matching active DB row is a no-op as far as this extension is concerned. Directus's native Liquid renderer handles it the same way it always has.

### Protected rows can be edited but not deleted

`base`, `password-reset`, `user-invitation`, `user-registration`, and `admin-error` rows in `email_templates` (and their corresponding entries in `email_template_variables`) are flagged `is_protected = true`. Their content is fully editable; only deletion is blocked, via filter hooks on the respective `items.delete` events.

<br />

---

<br />

## Contributing

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) for bug reports, feature requests, and PRs.
