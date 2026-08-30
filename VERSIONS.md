# Pinned Dependency Versions

Versions selected on 2026-08-30, per project's dependency version policy (no floating `latest` tags).

| Dependency  | Version   | Source / verified against               |
|-------------|-----------|-------------------------------------------|
| Next.js     | latest stable at scaffold time (see package.json) | npx create-next-app@latest |
| PostgreSQL  | 18.6      | latest stable major (19 is in beta as of this date) |
| Valkey      | 9.1.0     | latest stable release |
| Grafana     | 13.2.0    | latest stable release |

Versions will only be updated via a dedicated dependency-update ticket, not incidentally on container rebuild.