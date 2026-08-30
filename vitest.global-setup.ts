import { resolveAdminDatabaseUrl, resolveTestDatabaseUrl, TEST_DB_NAME } from "./vitest.helpers";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");

  const admin = new Pool({ connectionString: resolveAdminDatabaseUrl() });
  const existing = await admin.query<{ 1: number }>(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [TEST_DB_NAME],
  );
  if (existing.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  }
  await admin.end();

  const testPool = new Pool({ connectionString: resolveTestDatabaseUrl() });
  try {
    await migrate(drizzle(testPool), { migrationsFolder: "./drizzle" });
  } finally {
    await testPool.end();
  }

  return async () => {
    const teardown = new Pool({ connectionString: resolveAdminDatabaseUrl() });
    try {
      await teardown.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    } finally {
      await teardown.end();
    }
  };
}
