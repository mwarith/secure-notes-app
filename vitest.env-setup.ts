import { resolveTestDatabaseUrl } from "./vitest.helpers";

process.env.DATABASE_URL = resolveTestDatabaseUrl();
