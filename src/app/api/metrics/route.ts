import {
  processStartedAtEpochMs,
  readCounter,
} from "@/lib/metrics";

/**
 * Prometheus text exposition of the counter seam (PRD §11). The seam
 * (src/lib/metrics.ts) is frozen and consumed as-is: readCounter per
 * catalog entry, no seam changes.
 *
 * prom-client vs hand-rolled (deliberate): prom-client wants its own
 * Counter objects created up-front and updated through its API, so behind
 * a frozen plain Map<number> seam it would only mirror values into a
 * parallel registry on every scrape — an extra layer with no gain.
 * Hand-rolled exposition is ~40 lines, needs no dependency, and is
 * directly unit-testable; HELP/TYPE curation is explicit either way.
 *
 * Dot mapping (seam counter names use dots, Prometheus names may not):
 * - "errors.<class>"  -> family app_errors_total with label class="<class>"
 * - already-compliant names (autosave_failures_total) pass through as-is
 * A future "errors.<x>" seam counter needs one catalog line below.
 *
 * Non-sparse exposition (ENG-54, superseding the old "absent reads as
 * zero" sparse stance): every catalog family is emitted every scrape,
 * including at 0. Sparse exposition made a fresh process (web restart or
 * recreate) serve an EMPTY body: Prometheus saw the series go absent and
 * reappear at the reset value — a silent drop (drill finding F2, live in
 * the ENG-54 Phase 1 restart experiment). Absence is NOT unambiguous zero
 * once restarts exist: it breaks resets()/rate() continuity, and the
 * in-memory registry demonstrably resets with the process while
 * RestartCount stays 0 (docker tracks restart-policy restarts only).
 * Continuity is what keeps rate()/increase() reset-correct across
 * restarts, so counters are always present.
 *
 * Restart visibility (ENG-54): the body also carries
 * app_process_start_time_seconds (gauge, epoch seconds — restarts show as
 * a jump) and a Prometheus-standard _created line per counter sample
 * (family name minus _total, same labels, value = process start epoch).
 * Verified live on the compose Prometheus (v3.14.0, enable-feature=""):
 * _created series are ingested but rate()/increase() do not consume them
 * without the created-timestamp feature flag — the reset correction that
 * actually keeps rate()/increase() honest across restarts here is series
 * continuity (non-sparse exposition) plus the engine's decrease-based
 * reset correction. The _created lines ride along for engines (or future
 * flag flips) that do consume them; do not credit them on this engine.
 *
 * Auth stance: the body is aggregate counters only — no secrets, tokens,
 * session values, or user identifiers (the frozen seams forbid them). The
 * consumer is the compose-internal Prometheus scraper (prometheus.yml
 * targets web:3000, metrics_path /api/metrics); a production deployment
 * would restrict the route at the network or reverse-proxy layer rather
 * than in the application (PRD §11 asks for exposure, not public access).
 */

const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

interface MetricFamily {
  name: string;
  help: string;
}

const APP_ERRORS_FAMILY: MetricFamily = {
  name: "app_errors_total",
  help: "Application failures captured by the error classification layer, by error class.",
};

const AUTOSAVE_FAILURES_FAMILY: MetricFamily = {
  name: "autosave_failures_total",
  help: "Autosave flushes that failed and were surfaced to the editor for retry.",
};

const NOTES_CACHE_HITS_FAMILY: MetricFamily = {
  name: "notes_cache_hits_total",
  help: "Notes cache reads served from Valkey (ENG-36 helper; wired into the read path by ENG-37).",
};

const NOTES_CACHE_MISSES_FAMILY: MetricFamily = {
  name: "notes_cache_misses_total",
  help: "Notes cache reads that missed (absent, malformed, or Valkey unavailable).",
};

interface CatalogEntry {
  family: MetricFamily;
  seamName: string;
  classLabel?: string;
}

/** Every seam counter produced in production, mapped for exposition. */
const CATALOG: CatalogEntry[] = [
  {
    family: APP_ERRORS_FAMILY,
    seamName: "errors.operational",
    classLabel: "operational",
  },
  {
    family: APP_ERRORS_FAMILY,
    seamName: "errors.unexpected",
    classLabel: "unexpected",
  },
  {
    family: AUTOSAVE_FAILURES_FAMILY,
    seamName: "autosave_failures_total",
  },
  {
    family: NOTES_CACHE_HITS_FAMILY,
    seamName: "notes_cache_hits_total",
  },
  {
    family: NOTES_CACHE_MISSES_FAMILY,
    seamName: "notes_cache_misses_total",
  },
];

const PROCESS_START_FAMILY: MetricFamily = {
  name: "app_process_start_time_seconds",
  help: "Start time of this web process as epoch seconds (ENG-54): the in-memory counter registry resets with the process, so a jump marks a counter reset that docker's RestartCount does not record.",
};

/** Prometheus-standard _created name for a counter family (strip _total). */
function createdName(familyName: string): string {
  return familyName.endsWith("_total")
    ? `${familyName.slice(0, -"_total".length)}_created`
    : `${familyName}_created`;
}

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const startedAtSeconds = Math.floor(processStartedAtEpochMs() / 1000);
  const lines: string[] = [];
  const emittedFamilies = new Set<string>();

  lines.push(`# HELP ${PROCESS_START_FAMILY.name} ${PROCESS_START_FAMILY.help}`);
  lines.push(`# TYPE ${PROCESS_START_FAMILY.name} gauge`);
  lines.push(`${PROCESS_START_FAMILY.name} ${startedAtSeconds}`);

  for (const entry of CATALOG) {
    if (!emittedFamilies.has(entry.family.name)) {
      lines.push(`# HELP ${entry.family.name} ${entry.family.help}`);
      lines.push(`# TYPE ${entry.family.name} counter`);
      emittedFamilies.add(entry.family.name);
    }
    const value = readCounter(entry.seamName);
    lines.push(
      entry.classLabel
        ? `${entry.family.name}{class="${entry.classLabel}"} ${value}`
        : `${entry.family.name} ${value}`,
    );
    lines.push(
      entry.classLabel
        ? `${createdName(entry.family.name)}{class="${entry.classLabel}"} ${startedAtSeconds}`
        : `${createdName(entry.family.name)} ${startedAtSeconds}`,
    );
  }

  const body = `${lines.join("\n")}\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": CONTENT_TYPE },
  });
}
