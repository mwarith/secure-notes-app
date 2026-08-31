# Traceability

Maps PRD requirements to the tickets that implement them. Maintained incrementally as tickets land — add a row when a ticket is merged, not retroactively. Tickets are tracked manually in Linear (see `docs/agents/issue-tracker.md`).

## Coverage

| PRD section | Requirement | Ticket(s) | Status |
| --- | --- | --- | --- |
| §5.1 Account Creation | Register with email + password; clear feedback on invalid input, existing-account conflicts, password requirements | ENG-3 | Merged (PR #2) |
| §5.2 Sign In | Authenticate with email + password; safe failure feedback that does not expose account existence | ENG-4 | Merged (PR #3) |
| §5.5 Session Management | Secure authenticated sessions; no access after logout or expiry | ENG-4 | Merged (PR #3) |
| §5–§8 (persistence) | Data model: `users`, `sessions`, `notes`, `note_versions`, `audit_events` tables + Drizzle migration pipeline (see `docs/database-schema.md`) | ENG-2 | Merged (PR #1) |
| §8 Audit Log | Audit trail for auth activity (`account.created`, `login.success`, `login.failed`, `logout.success`); no secrets in metadata | ENG-3, ENG-4 | Merged |
| §15 Security (partial) | Repeated authentication abuse can be controlled: fixed-window rate limiting on login and registration | ENG-5 | Branch `ENG-5-rate-limiting` (not merged) |
| §15 Security (partial) | Sensitive information excluded from logs: hashed rate-limit keys, no secrets/tokens in audit metadata | ENG-3, ENG-4, ENG-5 | ENG-3, ENG-4 merged; ENG-5 in review |
| §17 Reliability (partial) | Graceful degradation: rate limiting fails open when Valkey is unavailable, with loud logging | ENG-5 | Branch `ENG-5-rate-limiting` (not merged) |
| §18 Technology Stack | Baseline: Next.js, TypeScript, shadcn/ui, PostgreSQL, Valkey, Prometheus, Loki | ENG-1, ENG-2 | Merged |
| §10–§11 Logging & Metrics | Observability infrastructure provisioned: Prometheus + Loki with Grafana datasources (application instrumentation not yet wired) | ENG-1 | Merged |
| §21 Local Development | Reproducible local orchestration: docker-compose for Postgres, Valkey, Grafana | ENG-1 | Merged |

Not yet started: §5.3–5.4 Two-Factor Authentication and Recovery, §6 Notes, §7 Note Version History, and the application-level instrumentation for §10–§12.

## Known limitations

- Session creation (ENG-4) depends on Valkey as authoritative storage. A Valkey outage breaks login entirely at createSession, which is a gap against PRD §17's requirement that supporting services should not become single points of failure for core user data. Discovered during ENG-5 review. Not fixed due to time constraints — logged as ticket ENG-X (session creation resilience during Valkey outage) and documented here as a deliberate trade-off rather than an oversight.
