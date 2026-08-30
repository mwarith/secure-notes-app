# secure-notes-app

A secure notes application built with Next.js, PostgreSQL, and Drizzle ORM.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

The full stack (web, PostgreSQL 18.6, Valkey, Grafana, Prometheus, Loki) is available via Docker:

```bash
docker compose up -d
```

## Database

Schema is defined with Drizzle ORM in `src/db/schema.ts`. Migrations are plain SQL files in `drizzle/`, applied with drizzle-kit.

### Apply migrations (single command)

```bash
npm run db:migrate
```

Reads `DATABASE_URL` from `.env`. Safe to re-run — applied migrations are tracked and skipped.

### Regenerate migrations after schema changes

```bash
npm run db:generate
```

### Schema decisions

Five tables: `users`, `sessions`, `notes`, `note_versions`, `audit_events`.

| Relationship | On delete | Rationale |
| --- | --- | --- |
| `notes.user_id` → `users.id` | `CASCADE` | Notes are the user's payload; deletion must not orphan them. Soft delete, if ever needed, is an app-level concern layered on top. |
| `note_versions.note_id` → `notes.id` | `CASCADE` | Versions are owned snapshots with no meaning detached from their note. |
| `sessions.user_id` → `users.id` | `CASCADE` | A deleted user must not have live sessions. |
| `audit_events.actor_user_id` → `users.id` | `SET NULL` (nullable) | Audit history survives user deletion; the actor reference is nulled, the event remains. |
| `audit_events.resource_type` / `resource_id` | no FK, nullable | Plain columns by design: deleting the referenced resource can never fail or erase the pointer, so audit rows stay queryable with the original resource id. Null when the event describes no concrete resource (e.g. failed login for an unknown email). |

- `note_versions` and `audit_events` are immutable: `created_at` only, no `updated_at`.
- `users.email` is unique; `sessions.token_hash` is unique (lookup key for session auth).
- `audit_events` has a composite index on `(resource_type, resource_id)` for resource-history queries.

## Registration

- Passwords are hashed with Argon2id (`@node-rs/argon2`, m = 19 MiB, t = 2, p = 1 — OWASP minimum config, pinned in `src/lib/auth/password.ts`).
- Password rule: 12–128 characters, no composition requirements (NIST SP 800-63B), and it must not contain the signup email.
- Emails are stored lowercased; uniqueness is exact-match.
- Duplicate emails return a neutral, non-enumerating error identical whether or not the account exists. The password is hashed before the uniqueness check so response timing does not leak account existence.
- Successful registration writes an `account.created` audit event. Registration never establishes a session.

## Sessions

- Sessions are 256-bit opaque tokens (`crypto.randomBytes(32)`, base64url) delivered in a `session` cookie: `httpOnly`, `sameSite=lax`, `path=/`, `maxAge=24h`, `secure` in production.
- Session state lives in Valkey, keyed by `session:{sha256(token)}` with a 24h TTL — Valkey is authoritative, and expired or invalidated sessions are rejected on use. A durable row is kept in the Postgres `sessions` table (deleted on logout), enabling future "revoke all sessions" flows.
- Login performs exactly one Argon2id operation per attempt: known emails verify the stored hash, unknown emails verify a precomputed dummy hash with the same cost parameters — response timing cannot reveal whether an email exists. All failures return the generic "Invalid email or password."
- Audit events: `login.success`, `login.failed` (metadata carries only `method` and an `outcome`, never passwords/tokens/emails), `logout.success`. Logout invalidates the session server-side and is a safe no-op when no session exists.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
