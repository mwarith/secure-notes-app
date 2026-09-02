import { readCounter } from "@/lib/metrics";

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
 * Exposition is sparse: a seam counter that was never incremented
 * (readCounter === 0) is omitted — an absent Prometheus counter already
 * reads as zero.
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
];

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const lines: string[] = [];
  const emittedFamilies = new Set<string>();

  for (const entry of CATALOG) {
    const value = readCounter(entry.seamName);
    if (value === 0) {
      continue;
    }
    if (!emittedFamilies.has(entry.family.name)) {
      lines.push(`# HELP ${entry.family.name} ${entry.family.help}`);
      lines.push(`# TYPE ${entry.family.name} counter`);
      emittedFamilies.add(entry.family.name);
    }
    lines.push(
      entry.classLabel
        ? `${entry.family.name}{class="${entry.classLabel}"} ${value}`
        : `${entry.family.name} ${value}`,
    );
  }

  const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return new Response(body, {
    status: 200,
    headers: { "content-type": CONTENT_TYPE },
  });
}
