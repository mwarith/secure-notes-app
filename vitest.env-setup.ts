import { resolveTestDatabaseUrl, resolveTestValkeyUrl } from "./vitest.helpers";

process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.VALKEY_URL = resolveTestValkeyUrl();
