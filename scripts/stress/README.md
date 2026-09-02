# ENG-41 stress-testing workflow (PRD §12)

One command that drives the compose stack over the app's **real HTTP surface** —
register, sign in, view workspace, create note, edit/save — at ramping
concurrency, and answers PRD §12's questions: how latency grows, when errors
start, what slows first, whether the system recovers.

## Run it

```powershell
py -m pip install -r scripts/stress/requirements.txt
py scripts/stress/stress.py --ramp 1,2,4,8 --iterations 3
```

Prerequisites: the compose stack up (`docker compose up -d`), Python 3.10+ with
pip. Dependencies are pinned in `requirements.txt` (httpx only) and install
into your user environment — the repo's npm dependencies are untouched.

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--base-url` | `http://localhost:3000` | the web service |
| `--ramp` | `1,2,4,8` | VU counts, one phase per value |
| `--iterations` | `3` | journey iterations per VU per phase |
| `--metrics-url` | `<base-url>/api/metrics` | metrics pull for the deltas |

## What you get

Per phase: per-operation latency percentiles (p50/p90/p99), throughput, and
error counts **by kind** — `http_error*` (transport/HTTP), `action_error`
(the action returned an error state), and `rate_limited`
("Too many attempts. Please try again later." — audited server-side as
`login.rate_limited` / `register.rate_limited`). Rate-limit activations are a
product-behaviour category, not crashes. Before/after each phase the script
pulls `/api/metrics` and prints counter deltas (`app_errors_total`,
`autosave_failures_total`) next to the latency report for interview narration.

Every VU sends a unique `x-forwarded-for` (the app's documented trusted-proxy
header; same technique as `e2e/helpers/test-account.ts`), so the login
(5/15min per IP+email) and registration (5/hour per IP) rate-limit windows stay
per-user and runs are repeatable back-to-back. Accounts and notes are unique
per run.

## How it drives the app (no test backdoors)

The wire protocol is the app's own Server Action fetch path:
`POST` to the page URL, `multipart/form-data` with the form fields prefixed
`_1_` plus one `0` field carrying the flight-encoded bound args, and the
`Next-Action: <id>` header. Every action id is harvested per run from public
responses — register/login ids from the pages' `$ACTION_*:0` hidden fields,
create/update ids from the served client chunks (the exported name sits beside
the id); the note id for updates comes from the workspace HTML payload. Nothing
is hardcoded; a redeploy that rotates ids is re-harvested automatically.

The full protocol research — including why the no-JS progressive-enhancement
POST was **not** used (it proved unreliable against this stack's static auth
pages) and the empirical evidence for every claim — is in
`docs/research/server-actions-form-post.md`.

## Notes and scope

- Client-side latency only: the app exposes no server timers (the metrics seam
  has no histograms — that instrumentation is a separate follow-up), so "what
  slows first" is read from the client-observed per-op latency plus the
  `/api/metrics` counter deltas.
- New app instrumentation, dashboards (ENG-40), log shipping (ENG-52), CI
  wiring, and the README docs pass (ENG-44) are out of scope.
- The workflow stops cleanly (Ctrl-C prints the summary) and prints a full
  summary even when many requests fail.
