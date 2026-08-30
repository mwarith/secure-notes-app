import { existsSync } from "node:fs";

export const TEST_DB_NAME = "secure_notes_test";

if (existsSync(".env")) {
  process.loadEnvFile();
}

function withDatabaseName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export function resolveTestDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example or create .env before running tests.",
    );
  }
  return withDatabaseName(base, TEST_DB_NAME);
}

export function resolveAdminDatabaseUrl(): string {
  return withDatabaseName(resolveTestDatabaseUrl(), "postgres");
}
