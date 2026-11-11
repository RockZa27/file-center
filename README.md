<div align="center">

# File Center

**Self-hosted file storage and sharing for small teams and families.**
One container, no database, your files stay on your own disk.

[![qa](https://github.com/RockZa27/file-center/actions/workflows/qa.yml/badge.svg)](https://github.com/RockZa27/file-center/actions/workflows/qa.yml)
![Bun](https://img.shields.io/badge/runtime-Bun%201.4-black?logo=bun)
![Vue](https://img.shields.io/badge/web-Vue%203-42b883?logo=vue.js)
![Docker](https://img.shields.io/badge/deploy-Docker-2496ed?logo=docker&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English · [ไทย](README.th.md)

[Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration) · [Updating](#updating) · [Documentation](#documentation) · [Development](#development)

</div>

---

File Center is a web app for keeping files on your own server and sharing them with people inside and outside your team.
It runs on [Bun](https://bun.sh) with [Elysia](https://elysiajs.com) on the server and [Vue 3](https://vuejs.org) + [Naive UI](https://www.naiveui.com) in the browser.
All state is plain files under one data folder, so a backup is a copy of that folder.

The web app is in **English and Thai**. The detailed guides in [`docs/`](docs/) are in Thai.

## Features

**Files**
- Drag-and-drop upload, whole folders, large files in resumable chunks (pause, resume, retry)
- Search, favorites, file versions, your own trash with undo
- Preview images, PDF, video, Office documents and the inside of zip files; edit code, Markdown and CSV in the browser
- Optional ONLYOFFICE integration for editing Office documents
- WebDAV with per-device app passwords (Windows, macOS, phones, rclone)

**Sharing**
- Download links with expiry, password and download limit
- Upload-request links so outsiders can drop files into a folder
- View-only links (preview without download, optional watermark)
- Share folders with users and groups; group folders with their own quota

**Security and privacy**
- Two-step sign-in (TOTP), can be required per role; signed-in devices list; lockout on repeated wrong passwords
- Password step-up for risky actions, CSRF protection, strict session lifetimes
- Optional ClamAV scanning of uploads, editor saves and unzipped files, with quarantine
- Private file modes on disk, optional AES-256-GCM encrypted backups
- Activity log with retention, forwarding to syslog (UDP, TCP or TLS) or a signed webhook
- Each person can see their own activity and download a copy of their personal data

**Administration**
- Roles: guest, user, manager, admin
- Per-user and per-group quotas, storage insight and duplicate finder
- Scheduled backups with restore from the web page
- One-click signed updates with automatic rollback
- Settings in the web page, alerts to e-mail, LINE, Discord, Slack, Telegram or any webhook

## Quick start

You need Docker with Compose v2.

```bash
git clone https://github.com/RockZa27/file-center.git
cd file-center
cp .env.example .env
```

Open `.env` and review it. The example turns on a Cloudflare Tunnel; for local or LAN use, remove the line `COMPOSE_PROFILES=tunnel`, set `TRUST_PROXY=false` and remove `TRUSTED_PROXIES`.

```bash
docker compose up -d --build
```

```bash
docker compose logs file-center
```

The log shows the random password of the `admin` account (unless you set `ADMIN_PASSWORD`). Open <http://localhost:3000>, sign in as `admin` and follow the prompts to change the password and set up two-step sign-in.

Data lives next to `docker-compose.yml`:

```
data/storage/   uploaded files
data/system/    users, settings, activity, sessions (JSON files)
data/backups/   backups (better on another disk)
.env            settings and secrets, never commit it
```

<details>
<summary><b>Run without Docker</b></summary>

You need Bun 1.4.4 or newer.

```bash
bun install
bun run build
bun start
```

`bun start` goes through the launcher so that web updates work. Data goes to `./storage` and `./data` (`STORAGE_DIR`, `DATA_DIR`).

</details>

## Configuration

Settings come from `.env`; many can also be changed in the web page under **System → Settings**, which wins over `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port on the host |
| `BIND_ADDRESS` | `127.0.0.1` | Set `0.0.0.0` to allow other machines on the LAN |
| `ADMIN_PASSWORD` | random | Password of `admin` on first start |
| `REQUIRE_2FA` | `staff` in the example | Who must use two-step sign-in |
| `PUBLIC_PAGE` | `off` in the example | Public download page for visitors |
| `UPLOAD_MAX_SIZE` | 10 GB | Largest single file, in bytes |
| `SECURE_COOKIE` / `TRUST_PROXY` | `false` | Set when served over HTTPS behind a proxy |
| `BACKUP_ENCRYPTION_KEY` | unset | Encrypt backups |

Every variable is listed in [docs/configuration.md](docs/configuration.md). Reverse proxies, Cloudflare Tunnel, 1Panel and ONLYOFFICE are covered in [docs/install.md](docs/install.md).

## Updating

Admins update from **System → Update**: check for a new version, type the password, and the app installs the signed package, test-starts it and rolls back if it does not come up.

Web updates ship only the app code. Rebuild the image (`docker compose up -d --build`) when a release notes a change to the `Dockerfile`, system tools or the launcher.

## Documentation

| Guide | Contents |
|---|---|
| [User guide](docs/user-guide.md) | Files, upload, sharing, trash, notifications, 2FA, WebDAV |
| [Admin guide](docs/admin-guide.md) | Roles, users, quotas, groups, backup and restore, updates, CLI |
| [Install](docs/install.md) | Docker in depth, proxies, tunnels, ONLYOFFICE, publishing updates |
| [Configuration](docs/configuration.md) | All environment variables and data files |
| [Security](docs/security.md) | Threat model, hardening, personal data, known limits |
| [Development](docs/development.md) | Code layout, tests, QA, releases, API reference |

The guides are written in Thai.

## Development

```bash
bun install
bun run dev        # API with watch + Vite dev server
bun test           # test suite
bun run typecheck
bun run qa         # full check: tests, typecheck, route coverage, budgets
```

```
src/      server (Elysia routes, auth, storage, backups, updater)
web/      browser app (Vue 3 + Naive UI)
tests/    bun test suites
scripts/  launcher, packaging, release, QA tools
docs/     guides (Thai)
```

CI runs the QA check, a Trivy scan, a Docker build and a benchmark on every push. See [docs/development.md](docs/development.md) for details.

## Security

Please report security problems privately through [GitHub security advisories](https://github.com/RockZa27/file-center/security/advisories/new) instead of a public issue. What the app protects and its known limits are described in [docs/security.md](docs/security.md).

## License

[MIT](LICENSE)
