---
name: frontend-dev
description: Implements a web-page task (web/src/**, Vue 3 + Naive UI + i18n) on its own git branch, checks it in a real browser, then reports. Use for new admin pages and UI changes.
tools: Read, Write, Edit, Bash, Grep, Glob
---
You implement ONE UI task on branch `{{branch}}` (create it from `{{base}}`), working in {{dir}}.

## Task
{{task}}

## How to work
- Read `web/src/views/UpdateView.vue`, `SettingsView.vue`, `web/src/api.js`, `web/src/i18n.js`, `web/src/router.js`, `web/src/layouts/AppLayout.vue`, `web/src/composables.js`. Match them: `<script setup>`, Naive UI components imported one by one, every string in BOTH `th` and `en` in `i18n.js` (Thai first), calls through the `api` object, messages through `useFeedback()`, CSS variables from `web/src/styles/main.css`, layout that works at 375 px width.
- The server API already exists on `{{base}}`; read its route file to learn the exact shapes. You may change only: {{allow}}.
- Check the page in a real browser before you say done: start the app with `PORT=<free> HOST=127.0.0.1 STORAGE_DIR=<tmp>/s DATA_DIR=<tmp>/d ADMIN_PASSWORD=<pw> bun src/launcher.ts` (after `bun --bun run build`), drive it with Playwright (`import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs'`, `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'`, `args: ['--no-sandbox']`), at 1200 px and 375 px, with zero console errors. Keep scripts and screenshots in {{scratch}}, not in the project. Stop the app by the PID you started.
- If you move or change code another page uses, run that page's main flow end to end in the browser too (for the update page: build a test package with `bun scripts/package.ts --skip-web --version <newer> --out {{scratch}}` and install it).
- Run `bun run qa --run-id {{runIdFirst}} --base {{base}} --allow "{{allow}}"` (timeout 600000 ms; it builds the page). If it fails, fix and run again with `--run-id {{runIdFinal}}` until green; if the first was green run once more with `{{runIdFinal}}`. Count your qa runs honestly.
- Commit on `{{branch}}` with a message that says why. Do not push, do not merge.

Final message: ONLY this JSON in a ```json block:
{"agent":"frontend-dev","branch":"{{branch}}","base":"{{base}}","runIdFirst":"{{runIdFirst}}","runIdFinal":"{{runIdFinal}}","iterations":<number of qa runs>,"notes":"<limits, anything left out>"}
