<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logos/lockup-white.svg">
    <img src="brand/logos/lockup-black.svg" alt="SubLane" width="420">
  </picture>
</h1>

<p align="center">
  A lightweight, multi-workspace subscription gateway. Codex first.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-171717?style=flat-square&amp;labelColor=555555" alt="License: AGPL-3.0-only" height="20"></a>
  <a href="go.mod"><img src="https://img.shields.io/badge/Go-1.26%2B-171717?style=flat-square&amp;logo=go&amp;logoColor=white&amp;labelColor=555555" alt="Go 1.26+" height="20"></a>
  <a href="web/package.json"><img src="https://img.shields.io/badge/React-19-171717?style=flat-square&amp;logo=react&amp;logoColor=white&amp;labelColor=555555" alt="React 19" height="20"></a>
  <a href="internal/storage/storage.go"><img src="https://img.shields.io/badge/SQLite-embedded-171717?style=flat-square&amp;logo=sqlite&amp;logoColor=white&amp;labelColor=555555" alt="SQLite embedded" height="20"></a>
  <a href="https://sublane.dev/docs/roadmap"><img src="https://img.shields.io/badge/stage-internal%20testing-92400E?style=flat-square&amp;labelColor=555555" alt="Stage: internal testing" height="20"></a>
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> · <a href="https://demo.sublane.dev/">Live demo</a> · <a href="https://github.com/murongg/SubLane">Repository</a> · <a href="brand/README.md">Brand materials</a>
</p>

SubLane brings AI subscriptions into one gateway with isolated workspaces for different teams. It runs as a single Go service with SQLite and a built-in web dashboard.

## Features

- **API channels:** Connect official OpenAI or third-party Chat Completions-compatible services with an API key and base URL, including encrypted keys, model discovery, connection checks, key rotation, existing pools, and usage accounting.
- **Subscription accounts:** Connect Codex, Claude, Antigravity and Grok Build through browser OAuth or credential JSON import, with encrypted credentials, connection checks, model discovery and quota snapshots. Grok uses device-code authorization; quota snapshots cover Codex, Claude usage windows, Antigravity per-model allowance and Grok subscription periods.
- **Client APIs:** OpenAI Responses, Chat Completions and Responses compaction, plus [Claude Messages and Gemini generation formats](https://sublane.dev/docs/protocols). Requests use HTTP/SSE, with WebSocket support for Responses. Client formats are independent of the selected subscription provider.
- **Workspaces and members:** Isolated accounts, pools, keys, usage and audit records; workspace roles, invitation registration and direct member access grants.
- **Account pools:** Model allowlists, model-aware account selection, conversation affinity, concurrency controls, cooldown recovery and Codex/Claude quota-aware routing and model-specific Antigravity quota admission.
- **Network proxies:** Fixed outbound proxy per account, bulk proxy import and manual exit checks.
- **Personal API keys:** Pool or allowance binding, expiry, pause and revocation controls, owner-only key copying and CC Switch import.
- **Usage controls:** Per-member request rate and concurrency limits, plus optional token or internal USD allowances, including percentage shares across multiple time-window budgets.
- **Content rules:** Optional workspace terms and regular expressions, with observe/block modes, encrypted matching content and checks before model dispatch across HTTP and WebSocket.
- **Operations:** Personal and workspace usage charts, activity heatmaps, request diagnostics, management audit logs, backup creation, verification and restore, and Codex client version settings.
- **Dashboard:** Embedded web interface in 11 languages, including English, Simplified Chinese, Traditional Chinese, Japanese, Korean, Spanish, French, German, Portuguese, Russian, and Arabic, with light and dark themes.

## Live demo

Open the [online demo](https://demo.sublane.dev/) and choose **Explore demo** on the login page. Browse sample accounts, pools and usage in read-only mode; live API calls are disabled.

## Screenshots

Captured from the read-only demo with sample data. Click a preview to view the full image.

| Workspace overview | Subscription accounts | Team usage |
| --- | --- | --- |
| [<img src="docs/assets/screenshots/overview-en-light.png" alt="Workspace overview with request statistics, usage trends and an activity heatmap" width="220">](docs/assets/screenshots/overview-en-light.png) | [<img src="docs/assets/screenshots/accounts-en-light.png" alt="Subscription accounts with quota snapshots, verification status and concurrency" width="220">](docs/assets/screenshots/accounts-en-light.png) | [<img src="docs/assets/screenshots/usage-en-light.png" alt="Team usage with request statistics, token totals and an activity heatmap" width="220">](docs/assets/screenshots/usage-en-light.png) |

## Quick start

Run the guided installer with curl and a checksum utility. Choose Docker Compose or the published Linux binary, then choose no proxy, Caddy, or Nginx:

```sh
curl -fsSL https://raw.githubusercontent.com/murongg/SubLane/main/scripts/install.sh | bash
```

Docker mode requires Docker Compose; binary mode requires Linux and a working systemd user manager. In a non-interactive shell, the installer retains the previous Docker-without-proxy default. Without a public domain, generated proxy configurations listen on local HTTP only. Open the URL printed by the installer, create the administrator, and name your first workspace in the guided setup. Connect a subscription, add it to an account pool, then create a personal key. Follow [First request](https://sublane.dev/docs/quickstart) to complete the connection; additional workspaces and usage limits can wait until you need them.

The script installs the latest stable release, or the newest prerelease if no stable release exists, in `./sublane`. Docker mode uses a named volume; binary mode uses a private data directory and systemd user service. For an existing script-managed installation, it offers an update in interactive mode; pass `--update --dir ./sublane` to update explicitly while preserving settings and data. Export and verify a backup before updating. For options, generated proxy files, HTTPS and upgrades, see the [deployment guide](https://sublane.dev/docs/deployment).

Add `--enable-updates` on a supported Linux installation to enable **System settings → Software updates** through a separate host worker. See [web updates](https://sublane.dev/docs/deployment#web-updates) for prerequisites and one-time setup.

## Development

Requires Go 1.26+, Node.js 24 and pnpm 9.12.2.

```sh
git clone https://github.com/murongg/SubLane.git
cd SubLane
make setup
make dev
```

Open http://127.0.0.1:5173. Air rebuilds and restarts the backend when Go code changes; Vite handles frontend HMR. Air runs at a pinned version without a global installation. Run `make check` to test and build the project.

## Documentation

To preview the interface with sample data, run `SUBLANE_DEMO=true make dev`, then choose **Explore demo** on the login page. This starts a disposable, read-only server demo; see [demo mode](https://sublane.dev/docs/deployment#demo-mode) for binary and Compose usage.

Follow the [step-by-step tutorial](https://sublane.dev/docs/guide/installation). Guides are maintained in the [documentation repository](https://github.com/murongg/sublane-website).

- [Deployment](https://sublane.dev/docs/deployment) · [Backup and restore](https://sublane.dev/docs/backup)
- [Providers](https://sublane.dev/docs/providers) · [Codex subscriptions](https://sublane.dev/docs/codex) · [Client protocols](https://sublane.dev/docs/protocols) · [Network proxies](https://sublane.dev/docs/proxies)
- [Workspaces](https://sublane.dev/docs/workspaces) · [Members](https://sublane.dev/docs/members) · [API keys](https://sublane.dev/docs/api-keys) · [Account pools](https://sublane.dev/docs/groups)
- [Model catalogs](https://sublane.dev/docs/models) · [Resource allowances](https://sublane.dev/docs/allocations) · [Team controls](https://sublane.dev/docs/team-controls)
- [Usage](https://sublane.dev/docs/usage) · [Request diagnostics](https://sublane.dev/docs/pool-runtime) · [Management audit](https://sublane.dev/docs/audit) · [System settings](https://sublane.dev/docs/settings)
- [Development](https://sublane.dev/docs/development) · [Architecture](https://sublane.dev/docs/architecture)
- [Releases](https://sublane.dev/docs/releases) · [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

[AGPL-3.0-only](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependencies and adapted components.
