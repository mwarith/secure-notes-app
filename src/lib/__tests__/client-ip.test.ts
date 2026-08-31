import { afterEach, describe, expect, it, vi } from "vitest";
import { getClientIp } from "../client-ip";

const { headers } = vi.hoisted(() => ({
  headers: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers,
}));

function mockRequestHeaders(values: Record<string, string>): void {
  headers.mockResolvedValue(new Headers(values));
}

afterEach(() => {
  headers.mockReset();
});

describe("getClientIp", () => {
  it("uses the first address in x-forwarded-for", async () => {
    mockRequestHeaders({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });

    await expect(getClientIp()).resolves.toBe("203.0.113.7");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    mockRequestHeaders({ "x-real-ip": "198.51.100.2" });

    await expect(getClientIp()).resolves.toBe("198.51.100.2");
  });

  it("falls back to x-real-ip when x-forwarded-for is empty", async () => {
    mockRequestHeaders({ "x-forwarded-for": " , 10.0.0.1", "x-real-ip": "198.51.100.2" });

    await expect(getClientIp()).resolves.toBe("198.51.100.2");
  });

  it("returns a shared unknown bucket when no proxy headers are present", async () => {
    mockRequestHeaders({});

    await expect(getClientIp()).resolves.toBe("unknown");
  });
});
