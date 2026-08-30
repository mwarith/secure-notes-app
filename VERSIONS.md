# Pinned Dependency Versions

Versions selected on 2026-08-30, per project's dependency version policy (no floating `latest` tags).

| Dependency          | Version                                           | Source / verified against                                              |
| ------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| Next.js             | latest stable at scaffold time (see package.json) | npx create-next-app@latest                                             |
| Drizzle ORM         | 0.45.2                                            | latest stable at selection time (npm view drizzle-orm version)         |
| drizzle-kit         | 0.31.10                                           | latest stable at selection time (npm view drizzle-kit version)         |
| pg (node-postgres)  | 8.23.0                                            | latest stable at selection time (npm view pg version)                  |
| @node-rs/argon2     | 2.2.0                                             | latest stable at selection time (npm view @node-rs/argon2 version)     |
| Vitest              | 4.1.11                                            | latest stable at selection time (npm view vitest version)              |
| vite-tsconfig-paths | 6.1.1                                             | latest stable at selection time (npm view vite-tsconfig-paths version) |
| PostgreSQL          | 18.6                                              | latest stable major (19 is in beta as of this date)                    |
| Valkey              | 9.1.0                                             | latest stable release                                                  |
| Grafana             | 13.2.0                                            | latest stable release                                                  |
| Prometheus          | 3.14.0                                            | latest stable release                                                  |
| Loki                | 3.7.4                                             | latest stable release                                                  |

Versions will only be updated via a dedicated dependency-update ticket, not incidentally on container rebuild.
