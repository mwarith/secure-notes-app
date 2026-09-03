import { vi } from "vitest";

/**
 * Captures the logger seam's JSON lines for assertions (ENG-16: the seam
 * writes via pino to process.stdout — a plain stream destination — instead
 * of console.*). Every captured line is parsed; non-JSON stdout noise is
 * ignored so unrelated output cannot break an assertion.
 *
 * Same role the console spies used to play: per-level counts and field
 * access, so behavioral assertions ("exactly one warn with event X") are
 * unchanged — only the capture channel moved with the implementation.
 */
export type LogLine = Record<string, unknown>;

export function captureLog(): {
  parsed: () => LogLine[];
  byLevel: (level: string) => LogLine[];
  restore: () => void;
} {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });

  function parsed(): LogLine[] {
    return chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LogLine];
        } catch {
          return [];
        }
      });
  }

  function byLevel(level: string): LogLine[] {
    return parsed().filter((entry) => entry.level === level);
  }

  return {
    parsed,
    byLevel,
    restore: () => spy.mockRestore(),
  };
}
