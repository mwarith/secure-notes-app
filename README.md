# Secure Notes

A private, versioned notes app with auditable, rate-limited authentication —
built as an interview take-home and developed ticket-by-ticket with AI coding
agents (see [How this was built](#how-this-was-built)). Next.js 16 App Router
with Server Actions, PostgreSQL 18, Valkey, and a full observability stack.

## What the app does

- **Accounts & sign-in** — email + password registration with non-enumerating
  feedback; Argon2id hashing; opaque-token sessions that survive Valkey
  outages via a durable Postgres fallback (PRD §5).
- **Two-factor authentication** — TOTP with QR enrolment, replay-protected
  login challenge, 8 single-use recovery codes, disable/reconfigure flows
  (PRD §5.3–§5.4, §16).
- **Notes** — create/edit/delete with every query ownership-scoped; debounced
  autosave with saving / saved / save-failed states and retry; silence-based
  version history with append-only restore (PRD §6–§7).
- **Audit log** — every security-relevant event as a dot-named
  `<entity>.<event>` row written inside the same DB transaction as the action
  (PRD §8).
- **Classified errors** — every failure is one of four classes
  (`user_input` / `auth` / `operational` / `unexpected`); retryability is
  derived from the class and users never see internals (PRD §9).
- **Observability** — `/api/metrics` Prometheus exposition, provisioned Grafana
  dashboards, and a repeatable Python stress workflow (PRD §10–§12).
- **Test pyramid** — 276 unit/integration tests (Vitest) and 21 Playwright
  browser specs over the real compose stack (PRD §13–§14).

## Quick start

Prerequisites: Docker Desktop, Node 22 (the Dockerfile's runtime), npm.

Create `.env` in the repo root — the compose web service and all local
tooling read it, and `docker compose up` fails without it:

```bash
# Required: Postgres connection (host tooling, migrations, tests)
DATABASE_URL=postgresql://notes_user:notes_pass@localhost:5432/secure_notes

# Optional: Valkey (defaults to redis://localhost:6379)
VALKEY_URL=redis://localhost:6379

# Required for two-factor authentication: an AES-256-GCM key that must
# decode to exactly 32 bytes. Generate one with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
APP_ENCRYPTION_KEY=paste-the-generated-base64-key-here
```

```bash
docker compose up -d          # web, postgres, valkey, grafana, prometheus, loki
npm install
npm run db:migrate            # safe to re-run — applied migrations are tracked and skipped
```

Then open http://localhost:3000 (or run `npm run dev` for hot-reload
development — it needs port 3000, so stop the compose web first with
`docker compose stop web`).

Service map:

| Service    | Endpoint                        | Notes                                  |
| ---------- | ------------------------------- | -------------------------------------- |
| web        | http://localhost:3000           | the app                                |
| Grafana    | http://localhost:3001           | `admin` / `admin` (documented local default) |
| Prometheus | http://localhost:9090           | scrapes `web:3000/api/metrics` every 15s |
| Loki       | http://localhost:3100           | receives web stdout via the Alloy sidecar (`job="secure-notes-web"`) |
| alloy      | —                               | ships web stdout to Loki (ENG-52)      |
| postgres   | localhost:5432                  | `notes_user` / `notes_pass`            |
| valkey     | localhost:6379                  |                                        |

## Verify the build

| Command | Expected result |
| --- | --- |
| `npm test` | 32 test files, **276 tests passed** |
| `npm run test:e2e` | **21 specs passed** (starts/reuses the compose web; serial by design for rate-limit budget isolation) |
| `npm run lint` | no findings, exit 0 |
| `npx tsc --noEmit` | no type errors, exit 0 |

## How this was built

This repository is the output of an **AI-assisted, ticket-driven workflow**
(PRD §22–§27): a product requirements document is decomposed into tickets,
each ticket is implemented by a coding agent against a written spec, reviewed,
merged by PR, and mapped back to the PRD in a traceability table. The docs are
the process:

- `docs/PRD.md` — the product spec (§1–§31), written before implementation.
- `docs/traceability.md` — PRD section → ticket(s) → merged PR, maintained
  incrementally as tickets land, plus the running Known-limitations list.
- `AGENTS.md` — the standing brief every coding agent reads (project
  requirements pointer, shared vocabulary, audit-event naming).
- `CONTEXT.md` — the domain vocabulary (PRD §22): the exact terms tickets,
  code, tests, and docs must share.
- `docs/agents/` — the agent workflow's own configuration (issue tracker,
  triage labels, domain doc layout).

Each ticket's diff is reviewable on GitHub; test-first delivery per PRD §26
is the norm, and two-agent review fixes are recorded in the traceability rows.

## Architecture

### Stack

| Layer          | Choice                                                   |
| -------------- | -------------------------------------------------------- |
| Framework      | Next.js 16.3.3 (App Router, Server Actions), React 19.2.8 |
| Language       | TypeScript (strict), ESLint flat config                   |
| Database       | PostgreSQL 18.6 via Drizzle ORM 0.45.2 (`node-postgres`)  |
| Session/cache  | Valkey 9.1.0 (`ioredis`)                                   |
| Auth crypto    | `@node-rs/argon2`, `otpauth`, `qrcode`                     |
| Unit/integration | Vitest 4.1.11                                            |
| Browser e2e    | Playwright 1.62.1                                          |
| Load testing   | Python 3.10+ / httpx 0.28.1 (`scripts/stress/`)            |
| Observability  | Prometheus 3.14, Loki 3.7.4, Grafana 13.2                  |

Pinned versions and the selection rationale live in `VERSIONS.md`
(PRD §19).

### Directory map

```
src/app/            routes, Server Actions, and client policy hooks
  api/metrics/      Prometheus text exposition of the counter seam
  (auth)/           register, login, 2FA challenge pages + actions
src/lib/            seams and pure logic (no framework types)
  auth/             password, session, register, login, totp, recovery codes
  logger.ts         JSON-line logger seam (pino-backed, ENG-16)
  metrics.ts        counter seam; process-wide registry (ENG-39)
  errors.ts         AppError + the four error classes (PRD §9)
  rate-limit.ts     fixed-window limiters, fail-open/closed policy
  audit.ts          in-transaction audit event writer
src/db/             Drizzle client + schema
drizzle/            SQL migrations (applied with npm run db:migrate)
e2e/                Playwright journeys + per-test IP isolation helpers
scripts/stress/     the ENG-41 stress workflow (see its README)
grafana-dashboards/ committed dashboard source, auto-provisioned
docs/               PRD, traceability, schema, research notes
```

### Key seams

The app is organized around small, deeply documented modules that hide policy
behind stable entry points:

- **`src/lib/logger.ts`** — one JSON line per entry, `{ ts, level, event, … }`;
  pino-backed (ENG-16) with mechanical secret redaction; call sites are frozen
  so the backing cannot ripple.
- **`src/lib/metrics.ts` + `src/app/api/metrics/route.ts`** — a process-wide
  counter registry; the route exposes `app_errors_total` (by class) and
  `autosave_failures_total` in Prometheus text format. The exposition is
  sparse: a never-incremented counter is omitted.
- **`src/lib/errors.ts`** — `AppError` carries one of the four error classes;
  `retryable` is derived from the class with no per-instance override, and
  `PRD9_CHECKLIST` maps PRD §9's ten feedback cases at compile time.
- **Pure policy modules** — save-trigger resolution, close-while-dirty,
  autosave timing: branching logic unit-tested without React.
- **Ownership-scoped queries** — every note/version read and write filters by
  the session's user id (CONTEXT.md: "Ownership-scoped query"); knowing a note
  id grants nothing.
- **`src/lib/next-redirect.ts`** — distinguishes thrown Next.js redirects from
  real failures so redirect control flow is not swallowed by error handling.
- **`src/lib/audit.ts`** — audit events are written with the caller's
  transaction, so an event and its action commit or roll back together;
  metadata never carries secrets.

## Security overview

Requirements live in PRD §5 (authentication) and §15 (security expectations);
the as-built behavior:

- **Passwords** — Argon2id (`@node-rs/argon2`, m = 19 MiB, t = 2, p = 1: OWASP
  minimum config, `src/lib/auth/password.ts`). Policy: 12–128 chars, no
  composition rules, must not contain the email (NIST SP 800-63B).
- **Non-enumeration discipline** — login verifies a dummy hash for unknown
  emails so timing is flat; duplicate-email registration hashes the password
  before the DB-level uniqueness check and returns the same neutral message.
- **Sessions** — 256-bit opaque tokens in an `httpOnly` `sameSite=lax` cookie;
  Valkey holds `session:{sha256(token)}` authoritatively with a durable
  Postgres row as fallback; logout revokes server-side.
- **Rate limiting** (PRD §15) — fixed windows in Valkey: login 5/15min per
  IP+email, registration 5/hour per IP, TOTP confirmation 5/15min per user.
  Login and registration **fail open** (a supporting service must not take
  down the core journey); code verification **fails closed** (a brute-force
  guard must not vanish with its store) — the rationale is documented in
  `src/lib/rate-limit.ts`.
- **2FA secrets at rest** — AES-256-GCM with a fresh 12-byte IV per write,
  `iv:tag:ciphertext` encoding, key from `APP_ENCRYPTION_KEY`, validated at
  first use (`src/lib/auth/totp-crypto.ts`).
- **Challenge replay protection** — per-session consumed-code check per
  RFC 6238 §5.2; codes are consumed atomically
  (`…AND used_at IS NULL RETURNING`).
- **Recovery codes** — 8 single-use codes issued at activation, shown once,
  stored only as sha256 hashes, never logged.
- **Audit events** — written in-transaction; named `<entity>.<event>`; secrets,
  tokens, and passwords never appear in metadata.

## Observability

- **Metrics** — `GET /api/metrics` exposes the PRD §11 counters; Prometheus
  scrapes it on a 15s interval (`prometheus.yml`).
- **Grafana** (http://localhost:3001, `admin`/`admin`) — datasources and the
  "Secure Notes" dashboard are provisioned from committed files
  (`grafana-dashboards.yml`, `grafana-dashboards/`): errors by class (rate +
  total), autosave failures, scrape health, and Loki log panels. A fresh
  `docker compose up -d grafana` loads everything from empty state.
- **Stress workflow** (PRD §12) — one command:

  ```bash
  py -m pip install -r scripts/stress/requirements.txt
  py scripts/stress/stress.py --ramp 1,2,4,8 --iterations 3
  ```

  Drives the real Server Action protocol (no test backdoors) through
  register → sign in → view → create → edit/save at ramping concurrency, and
  reports per-op latency percentiles, throughput, error counts by kind (rate
  limits reported as product behavior), and `/api/metrics` deltas per phase.
  Details: `scripts/stress/README.md`.

## Database

Schema is defined with Drizzle ORM in `src/db/schema.ts`; migrations are plain
SQL in `drizzle/` (`npm run db:migrate` applies, `npm run db:generate` creates
new ones after schema changes). `npm run db:migrate` is safe to re-run —
applied migrations are tracked and skipped.

Six tables: `users`, `sessions`, `notes`, `note_versions`,
`two_factor_recovery_codes`, `audit_events`. The design rationale (cascade
choices, the deliberately FK-free audit resource reference) and the as-built
deltas are documented in `docs/database-schema.md`.

## Known trade-offs

The running list lives in **`docs/traceability.md` → Known limitations**.
Highlights: session *creation* depends on Valkey even though session *reads*
fall back to Postgres (ENG-X); client-IP detection trusts proxy headers and is
documented as demo-scale-only (`src/lib/client-ip.ts`); log correlation IDs
deferred (no call-site-free mechanism in Next 16.3.3).

## More docs

- `docs/PRD.md` — the full product spec.
- `docs/traceability.md` — PRD section → ticket → PR map.
- `docs/database-schema.md` — schema design + as-built deltas.
- `CONTEXT.md` — domain vocabulary (PRD §22).
- `docs/research/` — research notes (TOTP/2FA; Server Actions over plain HTTP).
- `scripts/stress/README.md` — the stress workflow.
