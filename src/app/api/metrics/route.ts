import {
  processStartedAtEpochMs,
  readCounter,
} from "@/lib/metrics";

/**
 * Prometheus text exposition of the counter seam, hand-rolled (a counter
 * library behind the frozen Map seam would only mirror values into a
 * parallel registry). The seam is consumed as-is; a new seam counter needs
 * one catalog line below.
 *
 * Mapping: seam "errors.<class>" becomes family app_errors_total with
 * label class="<class>"; already-compliant names pass through. Every
 * catalog family is emitted EVERY scrape, including at 0 (non-sparse): the
 * in-memory registry resets with the web process, and an absent series
 * would read as a silent drop instead of a reset — continuity is what
 * keeps rate()/increase() reset-correct. app_process_start_time_seconds
 * makes restarts visible; each counter also carries a standard _created
 * line (this Prometheus ignores them, but continuity + resets() suffice).
 *
 * Auth stance: aggregate counters only — no secrets or user identifiers.
 * Intended consumer is the compose-internal Prometheus scraper; a
 * production deployment restricts the route at the network layer.
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
