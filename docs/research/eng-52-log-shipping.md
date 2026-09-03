# Log shipping: web stdout → Loki via declarative sidecar (ENG-52)

Research step of ENG-52 (ship the `web` container's stdout to Loki with label
`job="secure-notes-web"`, byte-intact, on Docker Desktop for Windows / WSL2,
fresh-clone safe). Method: primary sources only — grafana.com official docs,
github.com/grafana/alloy (releases + shipped source), hub.docker.com registry
API, docs.docker.com — all fetched 2026-09-03.

**Verdict: use Grafana Alloy as a single sidecar service. Promtail is EOL.
All 7 research questions resolved against primary sources; no contradictions.**

## 1. Promtail status in 2026 — EOL, do not use

- Official statement (Grafana Loki docs, Promtail agent page):

  > Promtail is end of life (EOL) as of March 2, 2026. Commercial support has
  > ended. No future support or updates will be provided. All future feature
  > development will occur in Grafana Alloy. … If you are currently using
  > Promtail, you must migrate to Alloy or another supported client.

  Source: https://grafana.com/docs/loki/latest/send-data/promtail/
- Latest promtail image tag on Docker Hub (registry API, newest tag first):
  `grafana/promtail:3.6.11` (pushed 2026-05-13, per hub.docker.com tag data —
  note the tag post-dates the EOL date; it is still an unmaintained image).
  Source: https://hub.docker.com/v2/repositories/grafana/promtail/tags?page_size=10
- Grafana provides a Promtail→Alloy config converter (`alloy convert
  --config.format=promtail`); the migration doc is linked from the Promtail
  page. Source: https://grafana.com/docs/loki/latest/setup/migrate/migrate-to-alloy/

**Conclusion: the sidecar must be Grafana Alloy.**

## 2. Current Alloy version and Docker tag — `grafana/alloy:v1.19.2`

- GitHub releases: **v1.19.2** is the release marked *Latest*, published
  2026-08-26 (release notes list only Windows static-linking and a
  govulncheck fix — no log-pipeline changes since v1.19.0, 2026-08-21).
  Source: https://github.com/grafana/alloy/releases
- Docker Hub registry API for `grafana/alloy` (362 tags): newest stable tag is
  **`v1.19.2`** (pushed 2026-08-26). Tag scheme is **`v`-prefixed semver**
  (`v1.19.2`, not `1.19.2`), with suffix variants
  (`v1.19.2-boringcrypto`, `v1.19.2-windowsservercore-ltsc2022`) plus `latest`
  and `boringcrypto`. At fetch time `latest` and `v1.19.2` shared the same
  manifest-list digest (`sha256:b8ec653c44235fbe910879145dac3597d66b0aaecf60bcbbe82580767771a839`).
  Sources: https://hub.docker.com/v2/repositories/grafana/alloy/tags?page_size=25
  and https://github.com/grafana/alloy/releases/tag/v1.19.2
- Digest pinning: possible (the per-arch linux/amd64 manifest digest is
  `sha256:1eeba15ef3193438c72f66efd3d76f769c523a4c661db0fae6eddde906004bc8`).
  This repo's convention (docker-compose.yml) is plain version tags for all
  six existing images (`postgres:18.6`, `valkey/valkey:9.1.0`,
  `grafana/grafana:13.2.0`, `prom/prometheus:v3.14.0`, `grafana/loki:3.7.4`),
  so **pin the plain tag `grafana/alloy:v1.19.2`** (note: `v` prefix, matching
  both Hub and the repo's prom/prometheus style).

## 3. Alloy in Docker — user, mounts, typical stanza

From https://grafana.com/docs/alloy/latest/set-up/install/docker/ :

- Typical run (Linux container):

  ```shell
  docker run \
    -v <CONFIG_FILE_PATH>:/etc/alloy/config.alloy \
    -p 12345:12345 \
    grafana/alloy:latest \
      run --server.http.listen-addr=0.0.0.0:12345 --storage.path=/var/lib/alloy/data \
      /etc/alloy/config.alloy
  ```

- Required mounts for shipping OTHER containers' logs: the Docker daemon
  socket `/var/run/docker.sock` (bind-mounted so `discovery.docker` /
  `loki.source.docker` can reach `unix:///var/run/docker.sock`) and the config
  file at `/etc/alloy/config.alloy`. State lives under the path given by
  `--storage.path`; the docs example uses `/var/lib/alloy/data`.
- Default user (verified from the published OCI image config, not docs): the
  v1.19.2 linux/amd64 image config has `config.User` **empty** → the container
  runs as **root by default**. Image history creates an `alloy` user
  (UID/GID 473) and `chown`s `/var/lib/alloy` to it, but there is no `USER`
  instruction, so root runs the entrypoint — no extra `user:`/`group_add:`
  is needed to read the docker socket. The image's default `Cmd` is already
  `run /etc/alloy/config.alloy --storage.path=/var/lib/alloy/data` (verified
  from the registry config blob), so no `command:` override is strictly
  required in compose.
- Docs note: "On macOS, Docker Desktop manages a Linux virtual machine
  transparently, so the Linux container commands work without modification" —
  same principle applies to the WSL2 backend on Windows (see §7).

## 4. `loki.source.docker` + `discovery.docker` + `discovery.relabel` schema

Source: https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.docker/

`loki.source.docker "LABEL" { host = HOST; targets = TARGET_LIST; forward_to = RECEIVER_LIST }`

Arguments (exact, from the reference table):

| Name               | Type                 | Default | Required | Notes |
|--------------------|----------------------|---------|----------|-------|
| `forward_to`       | `list(LogsReceiver)` | —       | yes      | e.g. `[loki.write.loki.receiver]` |
| `host`             | `string`             | —       | yes      | `unix:///var/run/docker.sock` |
| `labels`           | `map(string)`        | `{}`    | yes*     | default label set applied to entries (*optional in the implementation: `alloy:"labels,attr,optional"`) |
| `targets`          | `list(map(string))`  | —       | yes      | from `discovery.relabel…output` |
| `refresh_interval` | `duration`           | `"60s"` | no       | only used when connecting over HTTP(S), not unix socket |
| `relabel_rules`    | `RelabelRules`       | `{}`    | no       | entry-level relabeling; not needed here |

- **There is no `reassign_intervals` argument** — that belongs to Promtail's
  `docker_sd_config`, not to Alloy. Nothing else needs configuring for this
  use case; the optional blocks (`http_client_config`, `authorization`,
  `basic_auth`, `oauth2`, `tls_config`) apply only to HTTP(S) Docker daemons
  and "has no effect when connecting via a `unix:///` socket".
- `discovery.docker` (source:
  https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.docker/):
  `host = "unix:///var/run/docker.sock"` is the documented Linux example;
  `refresh_interval` defaults to `"1m"` (settable); `match_first_network`
  defaults to `true` (avoids duplicate targets for multi-network containers).
  Exported target labels include `__meta_docker_container_id`,
  `__meta_docker_container_name`, and
  **`__meta_docker_container_label_<labelname>`** for every container label,
  with dots/non-alphanumerics sanitized to underscores ("a Docker label
  `com.example.app.name` becomes `__meta_docker_container_label_com_example_app_name`").
  Since Docker Compose sets the canonical label
  `com.docker.compose.service` ("set on service containers with service name
  as defined in the Compose file" — compose-spec,
  https://github.com/compose-spec/compose-spec/blob/master/05-services.md),
  the meta label to filter on is exactly
  **`__meta_docker_container_label_com_docker_compose_service`**. ✔ verified.
- `discovery.relabel` (source:
  https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.relabel/):
  takes `targets`, exports `output`; `rule` blocks with `action = "keep"` +
  `source_labels` + `regex` filter targets, and a `rule { target_label = "job"
  replacement = "…" }` (`action = "replace"` default) attaches a static label
  to all remaining targets — this is the documented pattern ("Add a static
  label to all remaining targets"). Relabel regexes are fully anchored
  (Prometheus RE2 semantics), so `regex = "web"` matches exactly `web`.
- Because `loki.source.docker` merges each target's label set into the log
  entries (implementation:
  `internal/component/loki/source/docker/tailer.go`, `getStreamLabels()` —
  target labels minus `__`-prefixed ones become entry labels), the
  relabel-attached `job="secure-notes-web"` lands on every shipped entry.
  (Alternative: pass `labels = { "job" = "secure-notes-web" }` directly on the
  component; both are supported — the relabel route is used in the proposal
  per the ticket.)
- Duplicate targets (one per network × port mapping) are deduplicated by
  container ID: "loki.source.docker deduplicates them, and only keeps the
  first of each container ID instances, based on the `__meta_docker_container_id`
  label."

### Does it rewrite/parse lines? — No (raw lines preserved)

- The component parses only the **Docker daemon log-stream framing**: it
  requests logs with `Timestamps: true`, strips the daemon-added
  `RFC3339Nano ` timestamp prefix, and forwards the remainder verbatim as the
  entry line — `push.Entry{Timestamp: ts, Line: string(content)}` with no
  transformation of `content` (tailer.go, `process()` /
  `extractTsFromBytes()`). The `loki_source_docker_target_parsing_errors_total`
  metric counts Docker *message* (envelope/framing) parse errors, not JSON
  parsing of your log lines. Frames larger than 16 KiB are reassembled by
  stripping redundant continuation timestamps — again reconstructing the
  original line, not rewriting it.
- No `loki.process` stage is needed: there is nothing to parse, label, or
  mutate. The pino JSON lines from `web` reach Loki byte-identical, so
  LogQL `| json | event="…"` pipelines work unchanged.

## 5. Positions/state persistence — yes, persisted under `--storage.path`

- Component doc statement:

  > The component uses its data path, a directory named after the domain's
  > fully qualified name, to store its *positions file*. The positions file
  > is used to store read offsets, so that if a component or Alloy restarts,
  > `loki.source.docker` can pick up tailing from the same spot.

  Source: https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.docker/
- Implementation confirms it (`internal/component/loki/source/docker/docker.go`):
  a positions file `positions.yml` is created inside the component's
  `DataPath` (`filepath.Join(o.DataPath, "positions.yml")`, synced every 10 s),
  keyed per container ID; the tailer resumes with
  `ContainerLogs{ Follow: true, Since: <stored unix ts> }` — it resumes from
  the stored offset, not from the beginning.
- The base data path comes from the `run` flag `--storage.path`
  (https://grafana.com/docs/alloy/latest/reference/cli/run/ — default is
  `"data-alloy/"`, but the Docker image's default command already passes
  `--storage.path=/var/lib/alloy/data`, so no flag override is needed).
- **Volume to persist state:** a named volume mounted at
  `/var/lib/alloy/data` (proposed name `alloy_data`), matching the pattern of
  the existing compose volumes (`grafana_data`, `loki_data`, …). Caveat: the
  position is keyed by container ID — a *recreated* `web` container (new ID)
  is tailed from its own start (correct), while deleting the Alloy volume
  would make Alloy re-read the retained log buffer of *existing* containers
  (potential duplicates in Loki).

## 6. Log line integrity + Loki push endpoint

- Line integrity: see §4 — lines are forwarded byte-intact; no implicit JSON
  parsing; no `loki.process` stages anywhere in the pipeline. Sources:
  component reference (no line-transforming arguments exist) +
  https://github.com/grafana/alloy/blob/main/internal/component/loki/source/docker/tailer.go
- Loki ingest: `POST /loki/api/v1/push` is the ingest endpoint ("In microservices
  mode … exposed by the distributor"; in the default single-binary mode it is
  served by the `all` target that `grafana/loki` runs by default). Auth:

  > Note that authorization is not part of the Loki API. Authorization needs
  > to be done separately, for example, using an open-source load-balancer
  > such as NGINX.

  Multi-tenancy (`X-Scope-OrgID` header) only applies "If your cluster has
  Grafana Loki Multi-Tenancy enabled" — the default single-tenant setup used
  by this stack needs no auth headers. Sources:
  https://grafana.com/docs/loki/latest/reference/loki-http-api/

## 7. Docker Desktop for Windows (WSL2) — socket mount works

- Docker docs, bind mounts: "**For Docker Desktop, the daemon runs inside a
  Linux VM**, not directly on the native host. Docker Desktop has built-in
  mechanisms that transparently handle bind mounts, allowing you to share
  native host filesystem paths with containers running in the virtual
  machine." Source: https://docs.docker.com/engine/storage/bind-mounts/
- Docker docs, WSL2 backend: Docker Desktop runs "inside its own
  `docker-desktop` WSL distribution" (a full Linux environment); the "Use WSL
  2 based engine" setting is on by default where supported. Sources:
  https://docs.docker.com/desktop/features/wsl/ and
  https://docs.docker.com/desktop/features/wsl/use-wsl/
- Docker docs, dockerd reference: "By default, a `unix` domain socket … is
  created at `/var/run/docker.sock`" / "it listens on `unix:///var/run/docker.sock`".
  Source: https://docs.docker.com/reference/cli/dockerd/
- Chain: on Docker Desktop with the WSL2 backend, the daemon runs in the
  Linux VM and creates `/var/run/docker.sock` there; all containers of this
  compose project (Alloy included) run inside that same VM and bind-mount
  paths from the *daemon host*, so mounting
  `/var/run/docker.sock:/var/run/docker.sock` reaches the daemon exactly as
  on a Linux host. Grafana's `discovery.docker` / `loki.source.docker`
  examples use `host = "unix:///var/run/docker.sock"` for exactly this setup
  (the TCP-based example in those pages is only needed when Alloy itself runs
  on Windows outside a container).
- Note: bind-mount propagation is not used here (and "Mount propagation doesn't
  work with Docker Desktop" — irrelevant to a plain socket mount). Image
  default user is root (§3), so socket permissions are a non-issue.

## PROPOSED IMPLEMENTATION

### (a) Chosen sidecar — one paragraph

**Grafana Alloy** as a single declarative sidecar service in
docker-compose.yml. Rationale: Promtail — the previous default — is officially
EOL since 2026-03-02 with all future development in Alloy (§1), and Alloy's
`loki.source.docker` ships exactly this use case as a fully declarative,
self-contained config: it discovers containers through the daemon socket,
filters by Compose's `com.docker.compose.service` label via
`discovery.docker` + `discovery.relabel`, attaches `job="secure-notes-web"`
via relabel, tails stdout/stderr of the `web` service, and pushes to Loki —
parsing nothing and rewriting nothing, so the pino JSON lines stay
byte-intact for `| json` LogQL pipelines (§4, §6). Positions persist in
`positions.yml` under `/var/lib/alloy/data` (named volume), so restarts
resume rather than re-ship (§5). It needs no host-level steps, no Docker
plugins, and no `logging.driver` changes — fresh-clone safe on Docker
Desktop/WSL2 (§7).

### (b) Image tag to pin

```yaml
image: grafana/alloy:v1.19.2
```

(latest stable 2026-09-03; `v`-prefixed per Hub scheme and repo convention.
Optional hardening: `grafana/alloy:v1.19.2@sha256:b8ec653c44235fbe910879145dac3597d66b0aaecf60bcbbe82580767771a839`.)

### (c) Full proposed River config — `alloy.config.alloy` (new file, repo root)

Placed at the repo root to match the existing flat-file config convention
(`prometheus.yml`, `grafana-datasources.yml` live at root).

```alloy
logging {
  level  = "info"
  format = "logfmt"
}

// Discover containers through the daemon socket (works inside Docker Desktop's Linux VM).
discovery.docker "containers" {
  host            = "unix:///var/run/docker.sock"
  refresh_interval = "5s"
}

// Keep only the compose service "web" and attach the static job label.
discovery.relabel "web" {
  targets = discovery.docker.containers.targets

  rule {
    action        = "keep"
    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]
    regex         = "web"
  }

  rule {
    action        = "replace"
    target_label  = "job"
    replacement   = "secure-notes-web"
  }
}

// Tail web's stdout/stderr verbatim — no parsing, no rewriting, no loki.process.
loki.source.docker "web" {
  host       = "unix:///var/run/docker.sock"
  targets    = discovery.relabel.web.output
  forward_to = [loki.write.loki.receiver]
}

loki.write "loki" {
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
}
```

(Comments are for this document only. `job` reaches the entries because
`loki.source.docker` merges target labels minus `__meta_*` internals into each
log entry; the `refresh_interval = "5s"` is optional — default `"1m"` — for
fast pickup of restarted containers in a dev stack.)

### (d) Proposed docker-compose.yml service stanza

```yaml
  alloy:
    image: grafana/alloy:v1.19.2
    restart: unless-stopped
    depends_on:
      - loki
    volumes:
      - ./alloy.config.alloy:/etc/alloy/config.alloy:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - alloy_data:/var/lib/alloy/data
```

plus `alloy_data:` added to the top-level `volumes:` map. No `command:` needed
(the image's default Cmd is `run /etc/alloy/config.alloy
--storage.path=/var/lib/alloy/data`); no `networks:` needed (implicit default
network puts `loki` in reach); no `ports:` needed (add
`- "12345:12345"` and pass `--server.http.listen-addr=0.0.0.0:12345` only if
the debugging UI is wanted). Fresh-clone note: `alloy.config.alloy` must be
committed — a missing bind-mount source is created as a *directory* by Docker.

Verification after `docker compose up -d alloy`: `{job="secure-notes-web"} | json`
in Grafana Explore returns `event="…"` fields from the web container's pino
logs.

## Source list (claim → URL)

| Claim | Source |
|---|---|
| Promtail EOL 2026-03-02, migrate to Alloy | https://grafana.com/docs/loki/latest/send-data/promtail/ |
| Latest promtail tag 3.6.11 | https://hub.docker.com/v2/repositories/grafana/promtail/tags?page_size=10 |
| Alloy v1.19.2 = Latest release (2026-08-26) | https://github.com/grafana/alloy/releases |
| Docker tag scheme `v1.x.y`; `v1.19.2` newest; digest of `latest`=`v1.19.2` | https://hub.docker.com/v2/repositories/grafana/alloy/tags?page_size=25 |
| Docker run example, config mount path, boringcrypto variants | https://grafana.com/docs/alloy/latest/set-up/install/docker/ |
| `loki.source.docker` arguments, positions-file statement, dedup, example | https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.docker/ |
| `discovery.docker` args/defaults, `__meta_docker_container_label_<labelname>` sanitization, unix-socket example | https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.docker/ |
| `discovery.relabel` keep/replace rule schema, static-label example | https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.relabel/ |
| `run` flags, `--storage.path` default | https://grafana.com/docs/alloy/latest/reference/cli/run/ |
| `POST /loki/api/v1/push`, no auth in Loki API, tenant header only with multi-tenancy | https://grafana.com/docs/loki/latest/reference/loki-http-api/ |
| Compose canonical labels `com.docker.compose.project` / `.service` | https://github.com/compose-spec/compose-spec/blob/master/05-services.md |
| Daemon default unix socket `/var/run/docker.sock` | https://docs.docker.com/reference/cli/dockerd/ |
| Docker Desktop daemon runs in Linux VM; bind mounts resolved on daemon host | https://docs.docker.com/engine/storage/bind-mounts/ , https://docs.docker.com/desktop/features/wsl/ , https://docs.docker.com/desktop/features/wsl/use-wsl/ |
| Missing bind-mount file source is created as a directory | https://docs.docker.com/engine/storage/bind-mounts/ |
| Lines forwarded unchanged (`Line: string(content)`), positions.yml per component DataPath, resume via `Since` | https://github.com/grafana/alloy/blob/main/internal/component/loki/source/docker/tailer.go , https://github.com/grafana/alloy/blob/main/internal/component/loki/source/docker/docker.go |
| Image default Cmd + root default user (empty `config.User`), alloy UID 473 exists | Docker registry v2 API config blob for `grafana/alloy:v1.19.2` linux/amd64 (queried 2026-09-03) |
