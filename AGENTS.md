# Repository guide for coding agents

## Scope and purpose

This repository runs a production RSS briefing system plus an isolated Telegram collector and summary feed. The Node.js side owns source collection, candidate evaluation, AI review, email composition, admin pages, Telegram summaries, and RSS rendering. The Python/Telethon worker only collects Telegram messages and URLs.

Preserve these boundaries:

- Telegram data uses its own SQLite database. Telegram messages and per-channel summaries must never enter the ordinary briefing candidate, AI evaluation, or selection pipeline. The only crossing point is the completed cross-channel digest (Telegram 要点), which a brief appends as its own section after the brief body (RSS and email); raw messages never appear in a brief.
- A Telegram source of type `url` extracts URLs only. Never persist its message body, sender, media metadata, or message link.
- Sent briefs are immutable records. Do not regenerate or resend one without explicit user authorization.
- Delivery is idempotent. Keep the database uniqueness guards and eligibility checks intact.

## Repository map

- `apps/web/`: Fastify admin server and HTTP/RSS routes.
- `apps/worker/`: scheduled collection, AI evaluation, composition, maintenance, and Telegram supervisor entry points.
- `packages/ai/`: provider adapters, schemas, triage, review, and composition.
- `packages/connectors/`: network fetch, parsing, SSRF protection, throttling, and all-network sources.
- `packages/db/`: SQLite access and shared eligibility queries.
- `packages/domain/`: windows, rules, deterministic filters, clustering, risk, and ranking.
- `packages/telegram/`: Telegram database, settings, login socket, summaries, maintenance, RSS, and admin views.
- `packages/templates/`: email rendering and delivery.
- `telegram-worker/`: Python 3.11+ Telethon collector with its own `pyproject.toml` and `uv.lock`.
- `config/`: source inventory, versioned policy rules, and AI prompts.
- `migrations/`: append-only briefing database migrations.
- `deploy/`: systemd and reverse-proxy definitions.
- `tests/`: executable Node.js regression tests; each file can be run directly with `node`.

## Setup and verification

Use Node.js 22 or newer.

```bash
npm ci
npm run typecheck
npm test
```

For the Telegram worker, use `uv` and keep its environment inside `telegram-worker/.venv`:

```bash
cd telegram-worker
uv sync --dev
uv run pytest
uv run mypy src tests
uv run ruff check .
```

Run the narrowest relevant test while iterating, then run the full Node suite and TypeScript check before handing off a code change. Changes to `deploy/systemd/` must pass `node tests/systemd.test.ts`; changes to `config/rules.yaml` must pass `node scripts/validate-rules.mjs`.

## Change conventions

- This is TypeScript ESM with strict type checking. Keep `.ts` extensions in local imports.
- Use the existing SQLite prepared-statement and transaction patterns. Avoid introducing a second database abstraction.
- Migrations are append-only. Never rewrite an existing numbered migration; add the next migration and keep it idempotent where practical.
- Increment `meta.rule_version` and update its date whenever `config/rules.yaml` behavior changes. Completed historical briefs and Telegram summaries are not rewritten by a rule change.
- Add a regression test for every corrected production failure. Prefer conservative deterministic rules over broad fuzzy matching that could merge unrelated events.
- Keep all configured windows in `Asia/Taipei` unless a user explicitly changes the product requirement. If window hours change, update both `config/rules.yaml` and `deploy/systemd/brief-run.timer`.
- Source disablement stops new ingestion but does not delete history or revoke an RSS token. Token revocation/reset is a separate explicit operation.
- Telegram invitation links may validate an existing membership but the worker must never automatically join a group.

## Security and privacy

Never commit or print:

- `.env` files other than the placeholder-only `.env.example`;
- SQLite databases, WAL/SHM files, backups, generated feeds, or outboxes;
- `secrets.enc`, API keys, passwords, bearer/RSS tokens, TOTP seeds, phone numbers, or Telegram API credentials;
- Telethon `.session` files or the Telegram login Unix socket;
- login verification codes, 2FA passwords, raw private-group messages, or persisted URL-channel message content.

Secrets belong in the AES-GCM vault or production environment. Login codes and 2FA passwords only travel over the local Unix socket and must not appear in database rows, audit events, or logs. Preserve SSRF checks, URL protocol restrictions, access-log token redaction, CSRF checks, and private no-cache RSS headers.

Before publishing or committing a broad change, inspect the staged file list and scan staged content for credentials. Treat a public GitHub push as irreversible disclosure.

## Production operations

The working copy is not the production data directory. Production convention is:

- application: `/opt/briefing-system`;
- environment: `/etc/briefing/env`;
- data and sessions: `/var/lib/briefing`;
- services: `brief-web`, `brief-harvest`, `brief-fulltext`, `brief-run`, `brief-maintain`, `brief-telegram-collector`, and `brief-telegram-summary`.

Do not deploy, restart services, alter production data, reset tokens, or send/resend mail without authorization for that external mutation. When authorized, back up affected databases/session/configuration first, deploy only reviewed files, validate systemd configuration when relevant, and verify service status plus SQLite `integrity_check` afterward. Never expose production secrets or message bodies in reports.

The full briefing run intentionally fails closed when any candidate remains unresolved. systemd performs at most three delayed retries, and already completed AI evaluations are reused. Do not bypass the completeness gate merely to make a scheduled run appear successful.

## Git hygiene

- Preserve unrelated user changes and review `git status` before staging.
- Do not add generated artifacts, dependency directories, caches, local databases, sessions, or encrypted secret files.
- Keep commits focused and describe operational changes explicitly.
