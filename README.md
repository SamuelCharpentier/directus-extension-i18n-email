# Directus i18n Email Extension

Database-backed, multilingual transactional email for Directus. Translate system emails (password reset, user invitation, user registration) into every recipient's language — and ship your own transactional templates the same way.

- **DB is the source of truth.** Templates live in `email_templates`; admins edit them in the Data Studio.
- **Filesystem is a rendering cache.** Locale JSON files are auto-synced to `EMAIL_TEMPLATES_PATH/locales/<lang>.json` so Directus's Liquid renderer can consume them.
- **Idempotent bootstrap.** Required collections are created on first load. Protected system templates are seeded in FR + EN and cannot be deleted.
- **Variable registry.** Declare required variables per template; missing variables abort the send and notify admins.
- **Admin alerting.** Any dispatch failure sends an `admin-error` email to every admin-role user.
- **Safe by default.** Unknown template names pass through untouched, so existing raw Directus templates keep working.

<br />

---

<br />

## Install

```sh
npm ci && npm run build
```

Copy the built extension into your Directus `extensions/` directory (or use `directus-extension link`), then restart Directus. See the [official installation guide](https://docs.directus.io/extensions/installing-extensions.html) for other options.

On first start the extension will:

1. Create `email_templates`, `email_template_variables`, and `email_template_sync_audit` collections if missing.
2. Seed protected system templates (`password-reset`, `user-invitation`, `user-registration`, `admin-error`, `base`) in FR and EN.
3. Sync locale JSON files to `EMAIL_TEMPLATES_PATH/locales/<lang>.json`.

<br />

---

<br />

## How It Works

The extension registers an `email.send` filter. For every outgoing email:

1. Resolves the recipient's language (user profile → `directus_settings.default_language` → `I18N_EMAIL_FALLBACK_LANG` → `en`).
2. Fetches `email_templates` where `template_key = <template name>` AND `language = <effective lang>`. Falls back to the default language if the row is missing.
3. Validates required variables from `email_template_variables`. Missing variables abort the send and trigger an admin notification.
4. Injects `subject`, `from_name`, and the row's `strings` into the email as `template.data.i18n.*`.
5. Also injects the `base` layout strings as `template.data.i18n.base.*` (for shared footer/header copy).
6. Templates not present in the DB pass through untouched.

Any write to `email_templates` triggers a re-sync of the affected language's locale file.

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

| Variable                        | Default | Description                                                                                               |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `I18N_EMAIL_FALLBACK_LANG`      | `en`    | Language used when `directus_settings.default_language` is null.                                          |
| `I18N_EMAIL_FALLBACK_FROM_NAME` | —       | Display name used when a template row has no `from_name`. Falls back to `directus_settings.project_name`. |

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
├── admin-error.liquid          — internal: sent to admins on dispatch failure
└── locales/                    — AUTO-GENERATED from email_templates (do not edit by hand)
    ├── en.json
    └── fr.json
```

The `.liquid` templates are yours — copy the files under [examples/templates/](examples/templates) as a starting point. The `locales/` folder is a write-through cache of the DB; edits made there are overwritten on the next DB write.

<br />

---

<br />

## Collections

### `email_templates`

| Field            | Type    | Notes                                                              |
| ---------------- | ------- | ------------------------------------------------------------------ |
| `id`             | uuid    | PK                                                                 |
| `template_key`   | string  | e.g. `password-reset`, `base`, or your custom key                  |
| `language`       | string  | ISO short code (`fr`, `en`, …)                                     |
| `category`       | enum    | `system` \| `transactional` \| `marketing` \| `custom`             |
| `subject`        | string  | Email subject. Empty for the `base` layout.                        |
| `from_name`      | string? | Sender display name override                                       |
| `strings`        | json    | Arbitrary key → string map exposed in the template as `i18n.*`     |
| `description`    | text?   | Admin-facing explanation                                           |
| `is_active`      | boolean | Disable without deleting                                           |
| `is_protected`   | boolean | Protected rows cannot be deleted (system templates)                |
| `version`        | integer | Bumped on admin edits                                              |
| `checksum`       | string  | SHA-256 of `{ subject, from_name, strings }` — maintained by hooks |
| `last_synced_at` | ts?     | Last successful filesystem sync                                    |

Unique composite: `(template_key, language)`.

### `email_template_variables`

Declare what each template needs. If a variable is `is_required` and missing from `template.data`, the send aborts.

| Field           | Type    | Notes                        |
| --------------- | ------- | ---------------------------- |
| `template_key`  | string  | FK by convention             |
| `variable_name` | string  | e.g. `url`, `projectName`    |
| `is_required`   | boolean |                              |
| `is_protected`  | boolean | Variables for protected rows |
| `description`   | text    | Admin-facing                 |
| `example_value` | string  | Shown in docs / preview      |

Unique composite: `(template_key, variable_name)`.

### `email_template_sync_audit`

Append-only log of filesystem syncs. Written by the extension; read by admins for debugging.

<br />

---

<br />

## Liquid Templates

Templates are yours to design. Inside a template you have access to:

| Variable            | Source                          | Description                                                   |
| ------------------- | ------------------------------- | ------------------------------------------------------------- |
| `{{ i18n.* }}`      | Active template row's `strings` | Any key from the DB row's JSON payload                        |
| `{{ i18n.base.* }}` | `base` template row's `strings` | Shared layout strings (footer, org name, etc.)                |
| `{{ url }}`         | Directus                        | Action URL for system emails (reset link, invitation link, …) |
| `{{ projectName }}` | Directus                        | `directus_settings.project_name`                              |
| _other_             | Your caller                     | Anything you passed in `template.data`                        |

Strings in the DB are **plain text**. Liquid expressions written inside `strings` values are not re-rendered.

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

## Sending Custom Emails

Use the standard Directus `MailService` from your own extensions — this extension intercepts every send:

```ts
const mail = new services.MailService({ schema, accountability: null });

await mail.send({
	to: 'user@example.com',
	subject: 'fallback subject', // overridden by the DB row
	template: {
		name: 'order-shipped', // must match email_templates.template_key
		data: {
			url: 'https://shop.example.com/orders/42',
			trackingNumber: 'ABC123',
		},
	},
});
```

1. Create an `email_templates` row for each language with `template_key = 'order-shipped'`.
2. Declare required variables in `email_template_variables`.
3. Add `order-shipped.liquid` under `EMAIL_TEMPLATES_PATH`.

If no DB row exists for that key, the email passes through unchanged — Directus renders the Liquid template with whatever `data` you provided.

<br />

---

<br />

## Language Resolution

1. **User language** — `directus_users.language` of the recipient (primary tag, e.g. `fr` from `fr-CA`).
2. **Project default** — `directus_settings.default_language` (primary tag).
3. **`I18N_EMAIL_FALLBACK_LANG`** — used when the project default is null.
4. **`en`** — hard-coded last resort.

If no row matches `(template_key, effectiveLang)`, the extension retries with `(template_key, defaultLang)`. If that also misses, the email passes through untouched.

<br />

---

<br />

## Admin Error Notifications

When the extension cannot dispatch an email (missing required variable, DB error, etc.) it sends an `admin-error` email to every admin-role user. The template is seeded in FR + EN and receives:

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
```

Coverage thresholds are set to 100% on statements, branches, functions, and lines.

<br />

---

<br />

## Notes

### UI strings are separate

This extension translates **email content only**. Directus admin UI strings (e.g. the "password reset sent" confirmation on the login page) are handled by the Directus frontend i18n system and are not affected here. Override those via **Settings → Translations** in the Data Studio.

### Unknown templates pass through

Sending an email with a `template.name` that has no matching DB row is a no-op as far as this extension is concerned. Directus's native Liquid renderer handles it the same way it always has.

<br />

---

<br />

## Contributing

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) for bug reports, feature requests, and PRs.
