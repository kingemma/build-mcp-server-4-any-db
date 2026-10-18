# MCP Builder

**Configure GraphJin visually and turn any database into an MCP server.**

[中文](./README.md) · [Feature status](./docs/FEATURES.md)

MCP Builder is a desktop tool: enter a database connection, and it starts GraphJin,
discovers the schema, and writes your "role × table × operation" permissions into
GraphJin's config. The result is an HTTP endpoint (`/api/v1/mcp`) that Claude, Cursor
and other MCP clients can connect to directly — no hand-written YAML, no need to learn
GraphJin's config format.

![Connections page](./docs/screenshots/en-US/connections.png)

## Contents

- [Architecture](#architecture)
- [Features](#features)
- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [The GraphJin binary](#the-graphjin-binary)
- [Data and security](#data-and-security)
- [Verification](#verification)
- [Project layout](#project-layout)
- [Known limitations](#known-limitations)

## Architecture

```
┌───────────────────────────── Electron ─────────────────────────────┐
│  Vue 3 renderer (Pinia + Element Plus + vue-i18n)                  │
│         │ JSON-RPC over HTTP /rpc                                   │
│  Node backend (sidecar-backend)                                     │
│    ├── GraphJinSupervisor  process lifecycle, crash restarts        │
│    ├── McpClient           MCP Streamable HTTP client               │
│    ├── UserStore           users / orgs / connections (SQLite)      │
│    └── permission planner  role → table → op, applied via config    │
│         │ MCP tools                       │ child process           │
└─────────┼─────────────────────────────────┼─────────────────────────┘
          ▼                                 ▼
   GraphJin /api/v1/mcp              GraphJin (graphjin serve)
          │                                 │
          └─────────── business database (PostgreSQL / MySQL / SQLite …)┘
```

- **Why HTTP transport**: the bundled stdio proxy in v3.21.14 is broken (see the
  baseline doc), so the generated client config points straight at `/api/v1/mcp`.
- **Permission model**: the local role name *is* the GraphJin role name — no mapping
  layer. Writes take effect immediately.

## Features

### Runtime

Process state, endpoint, project directory, crash-restart count, health probe, stop,
and the copyable MCP client configuration.

![Runtime](./docs/screenshots/en-US/status.png)

### Connections

- Built-in drivers plus custom alias templates (TiDB / CockroachDB connect through the
  postgres / mysql protocol);
- Three input modes: file path, connection fields, connection string;
- **A connection is saved locally once a test or start succeeds**; the list below lets
  you refill the form, start from it, or delete it;
- Credentials are encrypted with the keystore key before hitting SQLite; the list only
  shows non-sensitive summary fields;
- Testing works even when the service is down: the backend spins up a throwaway
  GraphJin instance, validates, then stops it.

### Schema browser

The top bar lists the databases the running instance actually loaded. Picking one loads
its tables, columns and foreign keys only (`query_catalog` is filtered by
`database_name`, so multi-database projects never bleed into each other).

![Schema browser](./docs/screenshots/en-US/schema.png)

### Permission matrix

Role × table × four operations (Query / Insert / Update / Delete), plus:

- row filters (GraphJin DSL);
- column control: an allowlist, or a blocklist that is converted into its complement
  allowlist (GraphJin's `columns` only accepts an array);
- a default row `limit` for queries.

Every write shows a per-item diff and asks for confirmation.

![Permission matrix](./docs/screenshots/en-US/permissions.png)

### Policy preview

Reads the effective role policy from `get_current_config` and diffs it against the
pending matrix.

![Policy preview](./docs/screenshots/en-US/policy.png)

### Settings

Backend port, bundled GraphJin version and cached platforms, copyable version info. The
UI switches between **中文 / English** (top right) and remembers the choice.

![Settings](./docs/screenshots/en-US/settings.png)

## Requirements

| Dependency | Version / notes |
|:--|:--|
| Node.js | **>= 22.5** (the backend uses `node:sqlite`) |
| npm | ships with Node |
| GraphJin binary | You must fetch it yourself (see below); binaries are not committed |
| Browser (optional) | `verify:ui` drives a local Edge / Chrome |

## Install and run

```bash
npm install
```

### Desktop development

```bash
# terminal 1: Vite dev server (127.0.0.1:1420)
npm run dev

# terminal 2: Electron loads the dev server and starts the backend in-process
npm run electron:dev
```

### Browser-only debugging

```bash
npm run backend     # prints a ready JSON line containing the port
npm run dev         # open http://127.0.0.1:1420
```

Enter the backend port on the Settings page and click "Save and connect".

### Build the Windows installer

```bash
npm run dist:win    # output: release-final/
```

## The GraphJin binary

At build time the tarball in `graphjin-binaries/<version>/` is extracted and renamed to
`graphjin-<target-triple>` inside `src-tauri/binaries/` (packaged into
`resources/binaries/` via `extraResources`).

```bash
# download official release assets and verify sha256 (needs network and curl)
npm run fetch:binaries -- --only windows-amd64

# extract and rename the binary for the current platform
npm run prepare:binaries
```

Version and checksums live in `graphjin-binaries/version.json`; measured GraphJin
behaviour is documented in
[`docs/graphjin-3.21.14-baseline.md`](./docs/graphjin-3.21.14-baseline.md) (Chinese).

## Data and security

| Item | Location |
|:--|:--|
| Data directory | `userData/data` when packaged; `sidecar-backend/data` for `npm run backend` |
| Users / saved connections | `mcp-builder.db` inside it (override: `MCP_BUILDER_DB`) |
| Encryption key | `keystore.key` inside it (override dir: `MCP_BUILDER_DATA_DIR`) |
| Connection templates | `db-templates.json` inside it |
| GraphJin project | the "project directory" from the Connections page, e.g. `projects/app/dev.yml` |

- The connection `payload` is encrypted with AES-256-GCM (reusing GraphJin's keystore
  key); passwords and connection strings are never stored in clear text, and the list
  endpoint only returns host / port / dbname / user / path summaries.
- If `keystore.key` is lost, old records cannot be decrypted: the UI marks them
  "re-enter required" and still restores the non-sensitive fields.
- There is no rollback snapshot for policy writes — `update_current_config` takes effect
  immediately in legacy mode.

## Verification

```bash
cd sidecar-backend
npm test                 # backend unit tests (104)

npm run verify:e2e       # real end-to-end: start → discover → write permissions (17)

cd ..
npm run build
npm run verify:ui        # real backend + headless Edge, includes locale switching (10)
npm run verify:ui -- --shots=docs/screenshots   # regenerate both locale screenshot sets
```

`verify:ui` starts its own backend and creates two SQLite databases (`app` /
`analytics`); no manual setup required.

## Project layout

```
electron/              Electron main process, preload (injects the backend port)
src/                   Vue 3 renderer
  views/               six pages
  locales/             zh-CN / en-US copy
  stores/app.js        Pinia: service state, schema, permission matrix
sidecar-backend/       Node backend
  src/                 JSON-RPC, GraphJin client, permission planner, connection store
  test/                node:test suites
  scripts/             real-machine verification scripts
scripts/               binary prep, UI smoke test
docs/                  baseline notes, feature matrix, UI screenshots
src-tauri/binaries/    GraphJin binaries (extracted at build time)
```

## Known limitations

- The permission matrix lists tables from every database; it is not yet filtered by the
  selected database;
- macOS / Linux installers, code signing and CI are not wired up;
- `gj_security` needs an admin JWT, so the source of truth for policy is the MCP tool
  `get_current_config`;
- `dev.yml` merging is text-based and only understands the indentation this project
  generates.

The full done / not-done matrix is in [docs/FEATURES.md](./docs/FEATURES.md) (Chinese).
