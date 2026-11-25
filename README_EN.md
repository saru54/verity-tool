[中文](README.md) | [English](README_EN.md)

# verity-tool

[![Tests](https://github.com/saru54/verity-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/saru54/verity-tool/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.15-43853d)](https://nodejs.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

An extensible Node.js (ESM) verification workflow workbench featuring an authenticated Web UI, concurrent job queue, browser form-interaction adapters, per-task proxy isolation, and local PDF template rendering/archiving—designed for software engineering education, UI/state-machine testing, and authorized workflow automation research.

> **Compliance & Authorized Use:** This project is provided strictly for technical education, local testing, and **explicitly authorized** workflow verification/QA scenarios. Do not use it to forge documents or identities, impersonate others, bypass platform access controls, or send unauthorized bulk traffic. Always obtain proper authorization and comply with applicable laws and platform terms before testing against any live service; interactive human verification steps must always be completed by the operator. See [DISCLAIMER.md](DISCLAIMER.md) for details.

---

## Features

- **Web Workbench & Concurrent Job Queue**
  - Built-in queue manager (`WebJobs`) supporting configurable concurrency (`web.concurrency`), FIFO scheduling, cancel/resume, and job cleanup.
  - Assigns an isolated 24-hex random `taskId` per run and persists structured JSON event logs to `.runs/<taskId>.events.json` for inspection and export.
- **Built-in Web Authentication & CSRF Protection**
  - **Mandatory authentication**: refuses to start without configured credentials (`ONE_WEB_USERNAME` / `ONE_WEB_PASSWORD` or multi-user `ONE_WEB_USERS`, supporting `sha256:<64 hex>` pre-hashed digests).
  - Stores only SHA-256 digests in memory, applies per-IP exponential backoff on failed logins, issues `HttpOnly` / `SameSite=Strict` cookies (`Secure` when `ONE_WEB_PUBLIC_ORIGIN` is set), and enforces `Host`, `Origin`, `Sec-Fetch-Site`, and `X-Local-Token` checks on mutating endpoints.
- **Browser Automation Adapters**
  - Default **Camoufox** engine (via `playwright-core`) with optional **ShardBrowser** (Windows CDP launcher) support.
  - Multi-step mouse movement, randomized in-box click offsets, configurable typing cadence, and stable option-selection polling for both native `<select>` and ARIA combobox controls.
- **Per-Task Network & Proxy Isolation**
  - Uses Node.js `AsyncLocalStorage` with `undici` and `proxy-chain` so browser traffic and status polling share an isolated per-task proxy bridge.
  - Supports `direct`, static HTTP/SOCKS5 proxies, and configurable provider templates (`nodemaven` / `dataimpulse`) with optional pre-run connectivity/IP checks.
- **Template Document Rendering & Archiving**
  - Pure Node.js PDF generation (`src/materials/`) with `opentype.js` signature rendering and sample university fixture datasets (`US` / `CA` / `GB` / `DE`), plus `--file` / `--url` support for attaching operator-provided authorized documents.
  - Verifies archived files via SHA-256 and exposes preview/download endpoints (`GET /api/materials`) in the Web UI.

---

## Requirements

- **Node.js >= 22.15** (ESM + `--experimental-test-module-mocks`)
- **npm**
- Windows, Linux, or macOS (headed browser mode on Linux requires an active desktop/`DISPLAY`; headless mode works without a desktop)

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/saru54/verity-tool.git
cd verity-tool
npm ci
npm run browser:install
```

### 2. Configure

Copy the example configuration before editing (`config/*.local.json` and `shardbrowser.json` are gitignored):

```bash
# Linux / macOS
cp -n config/sheerid.example.json config/sheerid.local.json
chmod 600 config/sheerid.local.json

# Windows PowerShell
Copy-Item config/sheerid.example.json config/sheerid.local.json
```

> Configuration files must be strict JSON (no comments or trailing commas). Running `npm run web` will also auto-create `config/sheerid.local.json` from `config/sheerid.example.json` if missing.

If using ShardBrowser, copy `shardbrowser.example.json` to `shardbrowser.json` and set your local API token (or provide `SHARDBROWSER_TOKEN` / `SHARDBROWSER_ENDPOINT` via environment variables).

### 3. Set Credentials & Start the Web Workbench

```bash
# Linux / macOS
export ONE_WEB_USERNAME=ops
export ONE_WEB_PASSWORD="replace-with-a-strong-password"
npm run web

# Windows PowerShell
$env:ONE_WEB_USERNAME = "ops"
$env:ONE_WEB_PASSWORD = "replace-with-a-strong-password"
npm run web
```

For multiple accounts, use comma-separated `user:password` pairs (plaintext or `sha256:<hex>`):

```bash
ONE_WEB_USERS=ops:strong-password,audit:sha256:<64-hex-digest>
```

Open `http://127.0.0.1:8787` and sign in. Set `ONE_WEB_HOST=127.0.0.1` to bind locally only, and always configure `ONE_WEB_PUBLIC_ORIGIN=https://your-domain` behind HTTPS when exposing externally.

### 4. CLI Usage

```bash
# Fill form only and keep browser open (no submit)
npm start -- --config config/sheerid.local.json

# Query current verification status
npm run status -- --config config/sheerid.local.json

# Run full workflow
npm run submit -- --config config/sheerid.local.json
```

---

## Testing

The test suite runs offline with mocked APIs and local fixtures—no external verification requests are sent:

```bash
npm test
```

> Browser-dependent UI tests are automatically skipped if Camoufox is not installed locally. GitHub Actions CI runs `npm test -- --test-timeout=30000` on Node.js 24.

---

## Project Structure

```text
verity-tool/
├── config/                 # Example configuration template (sheerid.example.json)
├── deploy/                 # Linux systemd unit and Nginx reverse-proxy templates
├── docs/                   # Deployment, browser workflow, and materials documentation
├── examples/               # Static rendered HTML/PDF examples
├── scripts/                # Browser install and helper scripts
├── src/
│   ├── apps/sheerid/       # Form adapter, status polling, browser upload, language helper
│   ├── browser/            # Camoufox / ShardBrowser session and human-like form helpers
│   ├── core/               # Config validation, task locks, proxy bridge, IP check, runner
│   ├── data/               # Sample university fixture datasets
│   ├── materials/          # PDF template rendering, signature drawing, identity helpers
│   └── web/                # HTTP server, auth, job queue, and frontend console
└── tests/                  # Unit tests and fixtures
```

---

## Documentation

- [Deployment Guide (Linux / systemd / Nginx)](docs/DEPLOYMENT.md)
- [Browser Workflow Notes](docs/browser-workflow.md)
- [Document Templates & Archiving](docs/materials.md)
- [ShardBrowser Integration](docs/shardbrowser.md)
- [Security Policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Disclaimer](DISCLAIMER.md)

## License

Licensed under the [ISC License](LICENSE). Please review [DISCLAIMER.md](DISCLAIMER.md) before use.
