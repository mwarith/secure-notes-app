# Traceability

Maps PRD requirements to the tickets that implement them. Maintained incrementally as tickets land — add a row when a ticket is merged, not retroactively. Tickets are tracked manually in Linear (see `docs/agents/issue-tracker.md`); per-ticket details and trade-offs live in the GitHub PRs and the backlog file.

## Coverage

| PRD section | Requirement | Ticket(s) | Status |
| --- | --- | --- | --- |
| §18, §21 Technology Stack / Local Dev | Baseline: Next.js 16, TypeScript, shadcn/ui, PostgreSQL 18, Valkey, Prometheus + Loki + Grafana; docker-compose orchestration | ENG-1, ENG-2 | Merged |
| §5–§8 (persistence) | Data model: `users`, `sessions`, `notes`, `note_versions`, `two_factor_recovery_codes`, `audit_events` + Drizzle migration pipeline (see `docs/database-schema.md`) | ENG-2, ENG-27, ENG-31 | Merged (PR #1, #21, #26) |
| §5.1 Account Creation | Register with email + password; non-enumerating feedback; password requirements | ENG-3 | Merged (PR #2) |
| §5.2 Sign In | Authenticate with email + password; safe failure feedback; timing-oracle discipline | ENG-4 | Merged (PR #3) |
| §5.5 Session Management | Opaque token sessions (Valkey + durable Postgres row); no access after logout or expiry | ENG-4, ENG-30 | Merged (PRs #3, #24) |
| §5.3 Two-Factor — foundation | Research validation, encrypted secret schema, AES-256-GCM crypto, TOTP utils | ENG-27 | Merged (PR #21) |
| §5.3 Two-Factor — setup backend | Start-setup (generate + encrypt + store pending), confirm (verify-before-activation), confirm limiter, `2fa.enabled` audit | ENG-28 | Merged (PR #22) |
| §5.3, §16 Two-Factor — setup UI | `/settings/security`: explainer, QR, verify form, status states | ENG-29 | Merged (PR #23) |
| §5.3 Two-Factor — login challenge | Pending sessions, central active-session gate, challenge verify + replay protection (RFC 6238 §5.2), limiter fail-closed | ENG-30 | Merged (PRs #24, #25 — incl. second-agent review fixes) |
| §5.4 Recovery | Recovery codes: 8 single-use sha256-hashed codes at activation, atomic challenge consumption, `2fa.recovery_used` audit | ENG-31 | Merged (PR #26) |
| §5.3–§5.4 Disable/Reconfigure + auditable recovery actions | Password + factor verification, full teardown, `2fa.disabled`; recovery code regeneration | ENG-32 | Merged (PR #27) |
| §6 Notes — read/create/edit/delete + ownership | Ownership-scoped queries, workspace UI, editor, delete confirmation | ENG-7–ENG-12, ENG-26 | Merged (PRs #4–#7, #11, #20) |
| §6 Autosave | Debounced saves, status indicator, retryable failures, session resilience | ENG-13, ENG-14, ENG-15 | Merged (PRs #12, #13, #14) |
| §7 Note Version History | Creation boundaries (silence-based), history UI, restore (append-only) | ENG-21, ENG-22, ENG-23, ENG-24, ENG-25 | Merged (PRs #15–#19) |
| §8 Audit Log | Auth + note + version + 2FA events; dot-named, no secrets in metadata | ENG-3, ENG-4, ENG-9/10/25, ENG-28/30/32 | Merged |
| §9 Error Experience | Complete: classification layer (four classes, class-derived retryability, safe normalization, internal capture, compiler-checked ten-case map) + all auth and notes flows wired (no action can crash a submission; classified expected paths; delete-failure UX; checkpoint capture without UI) | ENG-33, ENG-34, ENG-35 | Merged (PRs #32, #33, #34) |
| §15 Security | Rate limiting (login, registration, TOTP paths — fail-closed on code verification), ownership boundaries, secret encryption, replay protection | ENG-5, ENG-7–10, ENG-27, ENG-30 | Merged |
| §17 Reliability | Bounded Valkey failures, durable session fallback, graceful page degradation | ENG-15 | Merged (PR #14) |
| §10–§11 Logging & Metrics | Infra provisioned (ENG-1); JSON logger + counter seams (ENG-15) — pino swap pending (ENG-16) | ENG-1, ENG-15 | Merged; ENG-16 pending |
| §13 Automated Testing | 245 tests (unit + integration) shipped per-ticket, red-green | per-ticket | Ongoing |

Not yet started: §10–§12 instrumentation details (ENG-16 pino swap, ENG-39 metrics endpoint, ENG-40 Grafana dashboards), §12 stress testing (ENG-41), §13 coverage sweep (ENG-42), §14 Playwright (ENG-43), docs pass (ENG-44), polish (ENG-45/46), demo dry run (ENG-51). Merged from the product-owner UX list: RTL support for note content (ENG-47, PR #28; covers note card, editor dialog, version history, and create-note dialog surfaces), the scrollable version history panel (ENG-48, PR #29), the register-page cross-link (ENG-49, PR #30), and create-note dismissal saving the note (ENG-50, PR #31).

## Known limitations

- **Session creation depends on Valkey** (login/register POSTs): reads fall back to the durable Postgres row (ENG-15), but session CREATION is still a hard dependency — fast-failing since ENG-15, previously a ~70s hang. Logged as ENG-X; a deliberate trade-off.
- **No 2FA disable via recovery code alone:** disable requires password + second factor; a user who lost both their device AND password is locked out (password recovery is out of scope — no email infrastructure).
- **Replay protection TOCTOU:** the challenge's replay check is get-then-set; two concurrent submissions of the same code could both pass (impact limited — attacker already holds the code). Atomic compare-and-set candidate for ENG-33/35.
- **Stale error on editor reopen** (`useActionState` has no reset API) and **thrown-delete silent close** (deferred to ENG-35) — see the backlog file for the full list.
