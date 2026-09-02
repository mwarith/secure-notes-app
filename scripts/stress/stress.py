"""ENG-41 stress-testing workflow (PRD §12).

Drives the compose stack over the app's REAL HTTP surface — no test-only
endpoints, no seeding. The wire protocol is the app's own Server Action
fetch path (`Next-Action` header + `_1_`-prefixed multipart + the `0`
bound-args field), with every action id harvested per run from public
responses: register/login ids from the pages' `$ACTION_*:0` hidden fields,
create/update ids from the served client chunks (the exported name sits
beside the id). Full protocol findings:
docs/research/server-actions-form-post.md.

Journeys: register, sign in, view workspace, create note, edit/save — the
realistic PRD §12 behaviour — at ramping concurrency. Each phase reports
per-operation latency percentiles (p50/p90/p99), throughput, and error
counts by kind, where rate-limit activations ("Too many attempts. Please
try again later." — audited server-side as login.rate_limited /
register.rate_limited) are reported as a product-behaviour category, not
crashes. Before/after each phase the script pulls /api/metrics and prints
counter deltas so the latency story can be narrated against PRD §11's
visibility surface.

Rate-limit isolation: every virtual user sends a unique `x-forwarded-for`
(the app's documented trusted-proxy header; same technique as
e2e/helpers/test-account.ts), so login (5/15min per IP+email) and
registration (5/hour per IP) windows stay per-user and the workflow is
repeatable back-to-back.

Usage:
    py -m pip install -r scripts/stress/requirements.txt
    py scripts/stress/stress.py --ramp 1,2,4,8 --iterations 3

One command, stops cleanly (Ctrl-C prints the summary), and prints a full
summary even when many requests fail.
"""

from __future__ import annotations

import argparse
import asyncio
import html as html_module
import json
import re
import time
from dataclasses import dataclass, field

import httpx

RATE_LIMITED_MESSAGE = "Too many attempts. Please try again later."
PASSWORD = "correct horse battery staple stress"

ACTION_PAGE_RE = re.compile(r'name="\$ACTION_(\d+):0" value="([^"]*)"')
CHUNK_SRC_RE = re.compile(r'src="(/_next/static/chunks/[^"]+\.js)"')
CHUNK_ACTION_RE = re.compile(
    r'"([0-9a-f]{42})"[^"]{0,140}?"(createNoteAction|updateNoteAction)"'
)
NOTE_RE = re.compile(r'\\"id\\":\\"([0-9a-f-]{36})\\",\\"title\\":\\"([^"\\]+)\\"')
METRIC_RE = re.compile(
    r"^(app_errors_total|autosave_failures_total)(?:\{([^}]*)\})?\s+([0-9.]+)$", re.M
)

OK = "ok"
ACTION_ERROR = "action_error"
RATE_LIMITED = "rate_limited"
HTTP_ERROR = "http_error"
OP_ORDER = ["register", "login", "view", "create", "update"]


@dataclass
class Sample:
    op: str
    outcome: str
    latency_ms: float
    detail: str = ""


@dataclass
class Phase:
    index: int
    vus: int
    iterations: int
    samples: list[Sample] = field(default_factory=list)
    wall_seconds: float = 0.0

    def failures(self) -> list[Sample]:
        return [s for s in self.samples if s.outcome.startswith(HTTP_ERROR)]


def is_hard_failure(outcome: str) -> bool:
    return outcome.startswith(HTTP_ERROR)


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = round((q / 100) * (len(ordered) - 1))
    return ordered[index]


def harvest_page_action_id(html: str) -> str:
    """Action id from a page's SSR `$ACTION_<n>:0` hidden field."""
    match = ACTION_PAGE_RE.search(html)
    if not match:
        raise RuntimeError("no $ACTION_<n>:0 hidden field in served HTML")
    desc = json.loads(html_module.unescape(match.group(2)))
    return desc["id"]


async def harvest_chunk_action_ids(
    html: str, client: httpx.AsyncClient
) -> dict[str, str]:
    """Action ids by exported name from the page's served client chunks."""
    ids: dict[str, str] = {}
    for src in CHUNK_SRC_RE.findall(html):
        response = await client.get(src)
        if response.status_code != 200:
            continue
        for match in CHUNK_ACTION_RE.finditer(response.text):
            ids.setdefault(match.group(2), match.group(1))
    return ids


def parse_metrics(body: str) -> dict[str, float]:
    counters: dict[str, float] = {}
    for name, labels, value in METRIC_RE.findall(body):
        key = f"{name}{{{labels}}}" if labels else name
        counters[key] = float(value)
    return counters


def metrics_delta(before: dict[str, float], after: dict[str, float]) -> str:
    keys = sorted(set(before) | set(after))
    parts = []
    for key in keys:
        old = before.get(key, 0.0)
        new = after.get(key, 0.0)
        sign = "+" if new >= old else ""
        parts.append(f"{key} {old:g}->{new:g} ({sign}{new - old:g})")
    return "; ".join(parts) if parts else "(no counters exposed - all zero)"


class Journey:
    """One virtual user's real HTTP journey: register → login → iterations
    of view workspace, create note, view again, edit/save."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        xff: str,
        email: str,
        action_ids: dict[str, str],
        samples: list[Sample],
    ):
        self.client = client
        self.xff = xff
        self.email = email
        self.action_ids = action_ids
        self.samples = samples
        self.last_response: httpx.Response | None = None
        self.session_token: str | None = None

    def headers(self) -> dict[str, str]:
        headers = {"x-forwarded-for": self.xff, "Origin": str(self.client.base_url)}
        if self.session_token:
            headers["Cookie"] = f"session={self.session_token}"
        return headers

    async def record(self, op: str, attempt) -> None:
        start = time.perf_counter()
        detail = ""
        try:
            outcome = await attempt() or OK
        except httpx.HTTPError as error:
            outcome = HTTP_ERROR
            detail = type(error).__name__
        except (RuntimeError, ValueError, KeyError) as error:
            outcome = f"{HTTP_ERROR}:driver"
            detail = str(error)[:100]
        latency_ms = (time.perf_counter() - start) * 1000
        self.samples.append(Sample(op, outcome, latency_ms, detail))

    async def fetch_page_action_id(self, path: str) -> str:
        response = await self.client.get(path, headers=self.headers())
        if response.status_code != 200:
            raise RuntimeError(f"GET {path} -> {response.status_code}")
        return harvest_page_action_id(response.text)

    async def call_action(
        self,
        path: str,
        action_id: str,
        fields: dict[str, str],
        state: dict,
    ) -> str | None:
        """POST a `useActionState` action the way the app's own JS does.

        Returns None on success, or an outcome label (rate_limited /
        action_error / http_error[:status]) when the action's returned
        state or HTTP status reports a failure.
        """
        files = [(f"_1_{name}", (None, value)) for name, value in fields.items()]
        files.append(("0", (None, json.dumps([state, "$K1"]))))
        response = await self.client.post(
            path,
            files=files,
            headers={**self.headers(), "Next-Action": action_id},
        )
        self.last_response = response
        if response.status_code != 200:
            return f"{HTTP_ERROR}:{response.status_code}"
        row = next(
            (line[2:] for line in response.text.splitlines() if line.startswith("1:")),
            None,
        )
        if row is None:
            return None
        try:
            state_result = json.loads(row)
        except json.JSONDecodeError:
            return None
        if isinstance(state_result, dict) and state_result.get("status") == "error":
            message = state_result.get("message", "")
            if message == RATE_LIMITED_MESSAGE:
                return RATE_LIMITED
            return ACTION_ERROR
        return None

    async def view_workspace(self) -> str | None:
        response = await self.client.get("/", headers=self.headers())
        if response.status_code != 200:
            return f"{HTTP_ERROR}:{response.status_code}"
        return None

    async def register(self) -> str | None:
        action_id = await self.fetch_page_action_id("/register")
        return await self.call_action(
            "/register",
            action_id,
            {"email": self.email, "password": PASSWORD},
            {"status": "idle"},
        )

    async def login(self) -> str | None:
        action_id = await self.fetch_page_action_id("/login")
        outcome = await self.call_action(
            "/login",
            action_id,
            {"email": self.email, "password": PASSWORD},
            {"status": "idle"},
        )
        if outcome:
            return outcome
        # `next start` flags the session cookie Secure (NODE_ENV=production);
        # httpx's jar would not replay it over plain http, so absorb the token
        # from the raw Set-Cookie header the way a browser's secure-context
        # localhost exception would.
        assert self.last_response is not None
        for cookie_header in self.last_response.headers.get_list("set-cookie"):
            match = re.match(r"session=([^;]+)", cookie_header)
            if match:
                self.session_token = match.group(1)
        if not self.session_token:
            return f"{HTTP_ERROR}:no_session_cookie"
        return None

    async def find_note_id(self, title: str) -> str:
        response = await self.client.get("/", headers=self.headers())
        if response.status_code != 200:
            raise RuntimeError(f"GET / -> {response.status_code}")
        for note_id, note_title in NOTE_RE.findall(response.text):
            if note_title == title:
                return note_id
        raise RuntimeError(f"created note {title!r} not found in workspace payload")


async def run_vu(
    base_url: str,
    phase: Phase,
    vu_index: int,
    run_nonce: int,
    action_ids: dict[str, str],
) -> None:
    xff = f"10.{run_nonce % 250}.{phase.index}.{vu_index}"
    email = f"stress-{run_nonce}-{phase.index}-{vu_index}@example.com"
    async with httpx.AsyncClient(
        base_url=base_url,
        timeout=httpx.Timeout(30.0),
        follow_redirects=False,
    ) as client:
        journey = Journey(client, xff, email, action_ids, phase.samples)
        await journey.record("register", journey.register)
        await journey.record("login", journey.login)
        login_samples = [s for s in phase.samples if s.op == "login"]
        if login_samples and login_samples[-1].outcome != OK:
            phase.samples.append(
                Sample("aborted", HTTP_ERROR, 0.0, "login failed; iterations skipped")
            )
            return
        for i in range(phase.iterations):
            await journey.record("view", journey.view_workspace)
            title = f"stress-note-{phase.index}-{vu_index}-{i}"

            async def create() -> str | None:
                return await journey.call_action(
                    "/",
                    action_ids["createNoteAction"],
                    {"title": title, "content": f"content v1 (iter {i})"},
                    {"status": "idle"},
                )

            await journey.record("create", create)

            note_holder: dict[str, str] = {}

            async def harvest() -> str | None:
                note_holder["id"] = await journey.find_note_id(title)
                return None

            await journey.record("view", harvest)

            async def update() -> str | None:
                return await journey.call_action(
                    "/",
                    action_ids["updateNoteAction"],
                    {"noteId": note_holder["id"], "title": title, "content": "content v2"},
                    {"status": "idle"},
                )

            await journey.record("update", update)


async def run_phase(
    base_url: str,
    phase: Phase,
    run_nonce: int,
    action_ids: dict[str, str],
) -> None:
    start = time.perf_counter()
    results = await asyncio.gather(
        *(
            run_vu(base_url, phase, vu_index, run_nonce, action_ids)
            for vu_index in range(phase.vus)
        ),
        return_exceptions=True,
    )
    phase.wall_seconds = time.perf_counter() - start
    for result in results:
        if isinstance(result, BaseException):
            phase.samples.append(Sample("vu_crash", HTTP_ERROR, 0.0, str(result)[:80]))


def report_phase(phase: Phase, before: dict[str, float], after: dict[str, float]) -> None:
    print(f"\n=== Phase {phase.index}: {phase.vus} VU(s) x {phase.iterations} iterations ===")
    ops: dict[str, list[Sample]] = {}
    for sample in phase.samples:
        ops.setdefault(sample.op, []).append(sample)
    print(f"  {'op':<12}{'n':>5}{'p50ms':>9}{'p90ms':>9}{'p99ms':>9}{'maxms':>9}  outcome counts")
    for op in OP_ORDER:
        group = ops.get(op, [])
        if not group:
            continue
        latencies = [s.latency_ms for s in group]
        counts: dict[str, int] = {}
        for sample in group:
            counts[sample.outcome] = counts.get(sample.outcome, 0) + 1
        outcome_note = ", ".join(f"{kind}={count}" for kind, count in sorted(counts.items()))
        print(
            f"  {op:<12}{len(group):>5}"
            f"{percentile(latencies, 50):>9.0f}{percentile(latencies, 90):>9.0f}"
            f"{percentile(latencies, 99):>9.0f}{max(latencies):>9.0f}  {outcome_note}"
        )
    outcomes: dict[str, int] = {}
    for sample in phase.samples:
        outcomes[sample.outcome] = outcomes.get(sample.outcome, 0) + 1
    total = len(phase.samples)
    rate = total / phase.wall_seconds if phase.wall_seconds > 0 else 0.0
    print(
        f"  throughput: {rate:.1f} ops/s over {phase.wall_seconds:.1f}s   "
        f"outcomes: {', '.join(f'{kind}={count}' for kind, count in sorted(outcomes.items()))}"
    )
    print(f"  /api/metrics delta: {metrics_delta(before, after)}")


def report_summary(phases: list[Phase]) -> None:
    print("\n=== Summary (whole run) ===")
    all_samples = [s for phase in phases for s in phase.samples]
    if not all_samples:
        print("  no samples recorded")
        return
    outcomes: dict[str, int] = {}
    for sample in all_samples:
        outcomes[sample.outcome] = outcomes.get(sample.outcome, 0) + 1
    latencies = [s.latency_ms for s in all_samples]
    print(
        f"  requests: {len(all_samples)}   outcomes: "
        + ", ".join(f"{kind}={count}" for kind, count in sorted(outcomes.items()))
    )
    print(
        f"  latency ms: p50={percentile(latencies, 50):.0f} p90={percentile(latencies, 90):.0f} "
        f"p99={percentile(latencies, 99):.0f} max={max(latencies):.0f}"
    )
    failures = [s for s in all_samples if is_hard_failure(s.outcome)]
    if failures:
        print("  first hard failures:")
        for sample in failures[:5]:
            print(f"    {sample.op}: {sample.outcome} {sample.detail}")
    else:
        print("  hard failures: none")
    rate_limited = outcomes.get(RATE_LIMITED, 0)
    if rate_limited:
        print(f"  rate-limit activations: {rate_limited} (product behaviour, audited server-side)")


async def main() -> int:
    parser = argparse.ArgumentParser(description="ENG-41 stress workflow (PRD §12)")
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--ramp", default="1,2,4,8", help="comma-separated VU counts per phase")
    parser.add_argument("--iterations", type=int, default=3, help="journey iterations per VU per phase")
    parser.add_argument("--metrics-url", default=None, help="defaults to <base-url>/api/metrics")
    args = parser.parse_args()
    metrics_url = args.metrics_url or f"{args.base_url}/api/metrics"
    ramp = [int(v) for v in args.ramp.split(",") if v.strip()]
    run_nonce = int(time.time() * 1000) % 100000

    print(f"ENG-41 stress workflow -> {args.base_url}")
    print(f"ramp={ramp} VUs, {args.iterations} iterations/VU/phase, unique x-forwarded-for per VU")

    async with httpx.AsyncClient(
        base_url=args.base_url, timeout=httpx.Timeout(30.0)
    ) as setup_client:
        response = await setup_client.get(f"{args.base_url}/register")
        response.raise_for_status()
        register_id = harvest_page_action_id(response.text)
        response = await setup_client.get(f"{args.base_url}/login")
        response.raise_for_status()
        login_id = harvest_page_action_id(response.text)
        # The workspace HTML (and its client chunks) is behind auth, so a
        # throwaway setup account bootstraps the session for chunk harvest.
        setup = Journey(
            setup_client,
            f"10.{run_nonce % 250}.254.254",
            f"stress-setup-{run_nonce}@example.com",
            {},
            [],
        )
        setup.action_ids = {"registerAction": register_id, "loginAction": login_id}
        if await setup.register() is not None or await setup.login() is not None:
            raise RuntimeError("setup account bootstrap failed; cannot harvest chunk action ids")
        response = await setup_client.get("/", headers=setup.headers())
        response.raise_for_status()
        action_ids = await harvest_chunk_action_ids(response.text, setup_client)
        for missing in ("createNoteAction", "updateNoteAction"):
            if missing not in action_ids:
                raise RuntimeError(f"{missing} id not found in served chunks")
        action_ids["registerAction"] = register_id
        action_ids["loginAction"] = login_id
    print(f"action ids harvested: {', '.join(sorted(action_ids))}")

    phases: list[Phase] = []
    try:
        for index, vus in enumerate(ramp):
            phase = Phase(index=index + 1, vus=vus, iterations=args.iterations)
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as metrics_client:
                before = parse_metrics((await metrics_client.get(metrics_url)).text)
            await run_phase(args.base_url, phase, run_nonce, action_ids)
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as metrics_client:
                after = parse_metrics((await metrics_client.get(metrics_url)).text)
            report_phase(phase, before, after)
            phases.append(phase)
    finally:
        report_summary(phases)

    hard_failures = sum(len(phase.failures()) for phase in phases)
    return 0 if hard_failures == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\ninterrupted — run stopped cleanly")
        raise SystemExit(130)
