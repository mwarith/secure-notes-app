# Valkey outage drill — notes cache (ENG-38)

The human runbook for demonstrating cache resilience and effectiveness —
PRD §28 demo step 19 ("show cache effectiveness") and PRD §17 (a failure in a
supporting service must not take down the core journey). The drill is executed
live by the orchestrator + product owner; this document is the script.

Everything below runs against the compose stack. No code changes, no test
accounts beyond a normal browser login.

## Prerequisites

1. Stack up — `docker ps` shows `secure-notes-app-postgres-1`,
   `secure-notes-app-valkey-1`, and `secure-notes-app-web-1` running. If a
   container exited, `docker start <container>` — never foreground
   `docker compose up` during the demo.
2. **Log into the app in the browser BEFORE the outage.** Session creation is
   a hard Valkey dependency (ENG-X): a login during the outage fails. The
   pre-existing session is unaffected — sessions are Valkey-cached but the
   outage path falls back to the durable Postgres row.
3. Open a second tab: Grafana → http://localhost:3001 (admin/admin) → the
   Secure Notes dashboard. Confirm the **Cache** row renders.

## Baseline (before the outage)

1. Capture the counters:

   ```powershell
   Invoke-RestMethod http://localhost:3000/api/metrics
   ```

   Note `notes_cache_hits_total` and `notes_cache_misses_total`.
2. In Grafana, browse the workspace for a moment (open a note or two) and
   point at the **Cache** row: the hit/miss rate lines and the hit-ratio stat
   move as reads are served from Valkey.

## Outage (stop Valkey)

```powershell
docker stop secure-notes-app-valkey-1
```

1. In the browser: **reload the workspace, open a note, edit + let autosave
   fire, restore an earlier version** — every journey still works with no
   user-visible change. The reads fall through to Postgres; writes are
   DB-only and their invalidation degrades gracefully.
2. Bounded failure is visible, not flooded:

   ```powershell
   docker logs secure-notes-app-web-1 --tail 50
   ```

   Expect a **few** `cache.valkey_failed` warn lines (one per failed cache
   operation, `operation=get|set|del`) — never a retry storm.
3. The metrics signature:

   ```powershell
   Invoke-RestMethod http://localhost:3000/api/metrics
   ```

   `notes_cache_misses_total` climbs while `notes_cache_hits_total` stalls.

## Recovery

```powershell
docker start secure-notes-app-valkey-1
```

Reload the workspace once — the first read misses and repopulates the keys;
after that, hits resume climbing in Grafana and the hit-ratio stat recovers.
Nothing else to do: caching resumes automatically.

## Narration template (demo step 19)

- **What to show**: the Cache row before the outage (hits and misses both
  moving, a healthy hit ratio), then the same row during the outage
  (misses spiking, hits flat, ratio dipping toward 0), then recovery.
- **What to say**: "Notes reads are served through a bounded Valkey cache.
  During a Valkey outage every cache read counts as a miss — that is why the
  hit ratio dips toward zero, it is the expected signature of the
  fail-degrade design, not an error — while the app keeps working exactly as
  before because every read falls back to the ownership-scoped Postgres
  query and every failed cache operation logs exactly one warning instead of
  retrying or throwing. When Valkey returns, the next read repopulates the
  cache and the ratio recovers on its own."
- **If asked about staleness**: writes invalidate the affected keys
  immediately after commit; the 60-second TTL only bounds staleness for the
  window where invalidation itself failed (e.g. Valkey down at write time).
