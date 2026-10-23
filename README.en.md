# File Center

[![qa](https://github.com/RockZa27/file-center/actions/workflows/qa.yml/badge.svg)](https://github.com/RockZa27/file-center/actions/workflows/qa.yml)

**Language:** [ไทย](README.md) · English

> This page is the English version of [README.md](README.md).
> The detailed documentation in [docs/](docs/) is written in **Thai only**, so the links below point to Thai pages.
> The web app itself has both Thai and English.

File Center is a self-hosted web app for storing and sharing files.
Your data stays on your own machine and no separate database is needed.
It is a full rewrite on **ElysiaJS + Bun** (backend) and **Vue 3 + Naive UI** (frontend),
designed to work and look much like the File Center built on FileGator, but it uses none of the old code or data.

## Contents

- [What it does](#what-it-does)
- [Roles](#roles)
- [Quick start with Docker](#quick-start-with-docker)
- [Run without Docker](#run-without-docker)
- [Updating](#updating)
- [Documentation (Thai)](#documentation-thai)

## What it does

- **Files and upload:** drag and drop, upload a whole folder, big files sent in pieces with pause / resume / retry.
  Search, favorites, earlier versions of a file, view and edit in the browser (code, Markdown, CSV and Office documents).
- **Share links:** download links with an expiry, a password and a download limit,
  and upload-request links that let outsiders send files into a folder.
- **Sharing with users and groups:** the "Shared with me" page, view-only or editable.
- **Group folders:** members share one folder, with a quota per group.
- **WebDAV:** use your files as a drive on Windows, macOS, phones and rclone, with app passwords.
- **Thumbnails, gallery and zip viewer:** pictures, PDF and video previews, and a look inside a zip without extracting it.
- **Notifications:** a bell in the web app, plus e-mail and LINE.
  Admins get system alerts on Discord, Slack, Telegram or any webhook.
- **Your own trash:** restore a deleted file or press "Undo". Admins also have a system-wide trash.
- **Scheduled backups:** daily, weekly or every N hours, with a compression level, a number of copies to keep,
  an option to include the uploaded files, and a free-disk-space check first.
- **One-click signed updates:** install from the web page; it rolls back by itself if the new version does not start.
- **Account security:** two-step verification (2FA), signed-in devices, lockout after wrong passwords, a storage quota per user.
- **Settings in the web page:** share-link policy, session length, lockout, upload size, trash, SMTP e-mail and the alert webhook are edited under System → Settings and apply at once (the web value wins over `.env`). 2FA can be required by role, and risky configuration is flagged.
- **In-app tour and help:** a welcome screen, a spotlight tour, a Help page (`/help`) and a "What's new" popup after each update.
- **Languages and theme:** the web app is in Thai and English, with a light/dark theme in the user menu.

## Roles

| Role | What they can do |
|---|---|
| **Guest** | Opens the site and downloads files in the public folder without signing in (can be turned off in Settings). |
| **User** | Signs in, manages files in their own folder, and uses the public folder with the rights they were given. |
| **Manager** (shown as "Admin") | Manages ordinary users and views their files read-only; sees a reduced dashboard and the activity of the users they look after. |
| **Admin** (shown as "Super admin") | Everything: all files, users, groups, permissions, dashboard, activity, trash, site settings, backups and updates. |

Details: [admin guide, roles and permissions](docs/admin-guide.md#บทบาทและสิทธิ์) (Thai).

## Quick start with Docker

You need Docker and Docker Compose v2.

1. Copy the settings file:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and edit what you need.
   - If you use it only on this machine or your LAN, delete or comment out the line `COMPOSE_PROFILES=tunnel` (the example turns on the Cloudflare Tunnel).
   - To choose the admin password yourself, set `ADMIN_PASSWORD=...`.
3. Build and start:
   ```bash
   docker compose up -d --build
   ```
4. Read the random `admin` password printed on first start (if you did not set `ADMIN_PASSWORD`):
   ```bash
   docker compose logs file-center
   ```
5. Open `http://localhost:3000` and sign in as `admin`. You are asked to change the password right away.

All data lives next to `docker-compose.yml`:

```
data/storage/    uploaded files
data/system/     users, settings, history, trash, sessions (plain JSON files)
data/backups/    system backups (better moved to another disk)
.env             settings; holds secrets, never share or commit it
```

By default the port is open to this machine only (`127.0.0.1:3000`).
Set `BIND_ADDRESS=0.0.0.0` in `.env` to let other machines on your LAN connect directly.

**Common settings** (everything is in [configuration](docs/configuration.md), Thai)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port on the host machine |
| `BIND_ADDRESS` | `127.0.0.1` | Which machines can reach the port directly |
| `ADMIN_PASSWORD` | random | Password of `admin` when it is first created |
| `UPLOAD_MAX_SIZE` | 10 GB | Largest file (bytes) |
| `SECURE_COOKIE` / `TRUST_PROXY` | `false` / `false` | Set when you serve over HTTPS and a proxy |
| `BACKUP_DIR` | `data/backups` | Where backups go |

**Common commands**

| To | Command |
|---|---|
| See the status | `docker compose ps` |
| Follow the log | `docker compose logs -f file-center` |
| Restart to re-read `.env` | `docker compose up -d` |
| Stop | `docker compose down` |

Moving machines, using a domain through a Cloudflare Tunnel, running behind 1Panel/nginx, and ONLYOFFICE are in [install](docs/install.md) (Thai).

## Run without Docker

You need [Bun](https://bun.sh) (Docker and CI use 1.4.2).

```bash
bun install
bun run build      # compile the web page (no Node installed? use: bun --bun run build)
bun start          # opens http://localhost:3000
```

- `bun start` goes through the launcher so that updates from the web page work.
- On first start the system creates the `admin` account and **prints a random password on the screen** (you must change it at first sign-in),
  or set one yourself with `ADMIN_PASSWORD=...` before the first start.
- Data goes to `./storage` and `./data`; change them with `STORAGE_DIR` and `DATA_DIR`.
- To work on the code (`bun run dev`, `bun test`) see the [developer guide](docs/development.md) (Thai).

## Updating

The super admin can update from the web page, with no FTP and no downtime.

1. Open **System** in the menu and choose the tab **System update**.
2. Press **Check and update**. If a newer version exists, press **Update now** (or drag a package `.zip` onto the page).
3. Type your password and press **Install and restart**. Wait 2-5 seconds.

Only signed packages are installed, the new version is test-started on the side first,
and the system goes back by itself if it does not come up (see the [admin guide](docs/admin-guide.md#อัปเดตระบบ), Thai).

**When you must run `docker compose up -d --build` again.**
An update from the web page ships only the app code, not system programs, the launcher or the Dockerfile. So rebuild when

- you turn on updating from the web page for the first time (so the image has the launcher),
- a release adds system tools, for example 1.11 added the thumbnail tools (vips, poppler, ffmpeg);
  without them the page shows icons instead of pictures,
- a release changes `Dockerfile`, `scripts/docker-entrypoint.sh` or `src/launcher.ts`.

If you only changed `.env` or `docker-compose.yml`, `docker compose up -d` is enough.
The full table is in [install](docs/install.md#เมื่อไรต้อง-build-อิมเมจใหม่) (Thai).

## Documentation (Thai)

| File | Contents |
|---|---|
| [User guide](docs/user-guide.md) | Daily use: files, upload, search, shortcuts, sharing, trash, notifications, 2FA, WebDAV, gallery, and the in-app guide. |
| [Admin guide](docs/admin-guide.md) | Roles and permissions, users, quotas, groups, the "System" page (backup/restore, update, logs, trash), system alerts (webhook) and the CLI. |
| [Install](docs/install.md) | Docker in detail, moving machines, container hardening, Cloudflare Tunnel, 1Panel/nginx, ONLYOFFICE, thumbnail tools, and publishing your own updates. |
| [Configuration](docs/configuration.md) | Every environment variable, grouped, with defaults, and the files in `DATA_DIR`. |
| [Security](docs/security.md) | What the system protects, 2FA and `secret.key`, container security, vulnerability scanning in CI, and known limits. |
| [Developer guide](docs/development.md) | Code layout, QA and CI, benchmark, making a signed release, how it differs from FileGator, and the API reference. |

Thai version of this page: [README.md](README.md).
