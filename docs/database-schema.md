# Secure Notes App — Database Schema (ENG-2)

Documented prior to implementation for review. ORM: Drizzle. Target: PostgreSQL 18.6.

---

## `users`

| Column                | Type          | Constraints                                        |
| --------------------- | ------------- | -------------------------------------------------- |
| `id`                  | `uuid`        | PK, default random                                 |
| `email`               | `text`        | unique, not null                                   |
| `password_hash`       | `text`        | not null                                           |
| `totp_secret`         | `text`        | nullable, encrypted at rest                        |
| `totp_enabled`        | `boolean`     | not null, default `false`                          |
| `recovery_codes_hash` | `jsonb`       | nullable — array of hashed one-time recovery codes |
| `created_at`          | `timestamptz` | not null, default now                              |
| `updated_at`          | `timestamptz` | not null, default now                              |

**Indexes:** unique on `email`.

---

## `sessions`

| Column       | Type          | Constraints                                      |
| ------------ | ------------- | ------------------------------------------------ |
| `id`         | `text`        | PK — session token or hash of it                 |
| `user_id`    | `uuid`        | FK → `users.id`, **ON DELETE CASCADE**, not null |
| `expires_at` | `timestamptz` | not null                                         |
| `created_at` | `timestamptz` | not null, default now                            |

**Indexes:** on `user_id`.

**Cascade reasoning:** a deleted user should have no lingering active sessions. No trade-off — CASCADE is unambiguous.

---

## `notes`

| Column       | Type          | Constraints                                      |
| ------------ | ------------- | ------------------------------------------------ |
| `id`         | `uuid`        | PK, default random                               |
| `user_id`    | `uuid`        | FK → `users.id`, **ON DELETE CASCADE**, not null |
| `title`      | `text`        | not null, default `''`                           |
| `content`    | `text`        | not null, default `''`                           |
| `created_at` | `timestamptz` | not null, default now                            |
| `updated_at` | `timestamptz` | not null, default now                            |

**Indexes:** on `user_id`.

**Cascade reasoning:** account deletion is a hard delete of all owned data in this project's scope (no shared notes, no data-retention requirement per PRD §30). A production system might soft-delete or offer export-before-delete; out of scope here. Documented as a deliberate trade-off.

---

## `note_versions`

| Column       | Type          | Constraints                                      |
| ------------ | ------------- | ------------------------------------------------ |
| `id`         | `uuid`        | PK, default random                               |
| `note_id`    | `uuid`        | FK → `notes.id`, **ON DELETE CASCADE**, not null |
| `title`      | `text`        | not null — snapshot at time of version           |
| `content`    | `text`        | not null — snapshot at time of version           |
| `created_at` | `timestamptz` | not null, default now                            |

**Indexes:** on `note_id`.

**Cascade reasoning:** a version's sole purpose is enabling restore of its parent note (PRD §7). Once the note is gone, there is nothing to restore into, so orphaned versions serve no product purpose.

---

## `audit_events`

| Column          | Type          | Constraints                                                    |
| --------------- | ------------- | -------------------------------------------------------------- |
| `id`            | `uuid`        | PK, default random                                             |
| `actor_user_id` | `uuid`        | FK → `users.id`, **ON DELETE SET NULL**, nullable              |
| `action`        | `text`        | not null — e.g. `login_success`, `note_deleted`, `2fa_enabled` |
| `resource_type` | `text`        | nullable — e.g. `note`, `user`, `session`                      |
| `resource_id`   | `uuid`        | nullable, **no FK constraint** (soft reference only)           |
| `metadata`      | `jsonb`       | nullable — non-sensitive context only (never secrets/tokens)   |
| `created_at`    | `timestamptz` | not null, default now                                          |

**Indexes:** on `user_id`, on `created_at`.

**Cascade / FK reasoning:**

- `user_id` uses `SET NULL`, not `CASCADE` or a hard blocking FK — audit history must survive account deletion (PRD §8), but the row still needs to honestly reflect that the account no longer exists.
- `resource_id` intentionally has **no FK constraint at all**. A real FK to `notes.id` would force either cascading deletes (destroying the audit trail) or blocking note deletion (defeating the point of deletion) — neither is acceptable for an audit log.
- `metadata` should snapshot enough non-sensitive context (e.g. note title at time of action) that the row remains meaningful after the referenced resource is gone.

---

## Entity Relationship Summary

```
users (1) ──< (many) sessions        [CASCADE]
users (1) ──< (many) notes           [CASCADE]
notes (1) ──< (many) note_versions   [CASCADE]
users (1) ──< (many) audit_events    [SET NULL]
(no FK)      audit_events.resource_id → notes.id (soft reference, unenforced)
```

## Design Notes

- All primary keys are `uuid` except `sessions.id`, which is the session token itself (or a hash of it).
- Every table has `created_at`; tables with mutable rows (`users`, `notes`) also have `updated_at`.
- No hard FK constraint ties `audit_events` to any specific resource table — this is deliberate, not an oversight, and should be called out explicitly if asked in review/interview.
- Secrets (`password_hash`, `totp_secret`, `recovery_codes_hash`) never appear in `audit_events.metadata`.

---

## As-Built Deltas

Differences between the pre-implementation design above and the schema that actually shipped (ENG-2 + ENG-4). The design intent and cascade reasoning above remain valid documentation.

- **`sessions`**: `id` is a `uuid` PK (default random) with a separate unique `token_hash` text column (sha256 of the opaque session token), not the token-as-PK design above. `updated_at` was added. Sessions live authoritatively in Valkey (`session:{sha256(token)}` key, 24h TTL) with this table as the durable record; rows are deleted on logout.
- **`audit_events`**: `resource_type` and `resource_id` shipped NOT NULL in migration 0000 — a drift from the design above; migration 0001 (`0001_audit_resource_columns_nullable`) restored the designed nullability. Rows describing no concrete resource (e.g. `login.failed` for an unknown email) carry NULL `actor_user_id`, `resource_type`, and `resource_id`. The implemented index is the composite `(resource_type, resource_id)`; the `user_id` / `created_at` indexes listed above are not yet built.
- **Audit event naming**: dot-style `<entity>.<event>` strings per AGENTS.md (`account.created`, `login.success`, `login.failed`, `logout.success`) — the snake_case examples above are superseded.
- **`users`**: the 2FA columns (`totp_secret`, `totp_enabled`, `recovery_codes_hash`) are deferred to the two-factor tickets and do not exist yet.
- **`notes`**: `title` / `content` are `not null` without defaults.

---

## As-Built Deltas — 2FA epic (ENG-27/30/31; migrations 0002–0004)

The two-factor tickets shipped their own schema; the deltas below supersede the
"deferred" note above and the pre-implementation 2FA design in the `users` table.

- **Migration 0002 (ENG-27)** — `users` gained the 2FA columns, renamed and
  reshaped from the design above:
  - `totp_secret_encrypted text` (nullable) — the TOTP secret encrypted at rest
    as `iv:tag:ciphertext` (three base64 segments; AES-256-GCM, 12-byte random
    IV per write, key from `APP_ENCRYPTION_KEY`). The design's `totp_secret`
    (plaintext) and `recovery_codes_hash jsonb` are superseded: the recovery
    codes moved to their own table (below) and only the encrypted TOTP secret
    lives on `users`.
  - `totp_enabled boolean NOT NULL DEFAULT false` — null secret = never
    started; secret + false = setup pending; true = active.
- **Migration 0003 (ENG-30)** — `sessions.pending_two_factor boolean NOT NULL
  DEFAULT false`: sessions created by a correct password on a 2FA-enabled
  account start pending and authenticate only for the challenge; the central
  active-session gate rejects them everywhere else. The flag lives in both the
  durable row and the Valkey payload (rewritten whole on activation — see
  `activateSession` in `src/lib/auth/session.ts` for the ordering rules).
- **Migration 0004 (ENG-31)** — NEW table `two_factor_recovery_codes` (instead
  of the designed `users.recovery_codes_hash jsonb`): one row per code,
  `code_hash` = sha256 of the trimmed/lowercased code (high-entropy random
  codes — sha256, not Argon2id; reasoning in `src/lib/auth/recovery-codes.ts`),
  `used_at` nullable — set atomically by the consuming query
  (`…AND used_at IS NULL RETURNING`), so a code can never be spent twice. Rows
  cascade with the user; the disable flow deletes all rows for the user.
- **Audit naming**: the 2FA events shipped as `2fa.enabled`,
  `2fa.challenge_passed`, `2fa.recovery_used`, `2fa.disabled`,
  `2fa.recovery_codes_regenerated` (dot-style, per AGENTS.md); replay-rejected
  and invalid 2FA codes audit as `login.failed` with
  `outcome: "invalid_totp_code"` / `"invalid_recovery_code"` in metadata.
