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
| `audit_events.resource_type` / `resource_id` | no FK | Plain columns by design: deleting the referenced resource can never fail or erase the pointer, so audit rows stay queryable with the original resource id. |

- `note_versions` and `audit_events` are immutable: `created_at` only, no `updated_at`.
- `users.email` is unique; `sessions.token_hash` is unique (lookup key for session auth).
- `audit_events` has a composite index on `(resource_type, resource_id)` for resource-history queries.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
