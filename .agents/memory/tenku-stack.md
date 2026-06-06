---
name: Tenku stack & run config
description: How Tenku is built, run, and deployed — key decisions that must stay consistent.
---

## Runtime
- Single "Start application" workflow: `PORT=8080 node --enable-source-maps artifacts/api-server/dist/index.mjs`
- Express serves both API (`/api`) and built React frontend (`dist/public`) from port 8080.
- PORT defaults to 8080 if not set (safe for local dev); required on Render (set to 10000).

## Build
- `pnpm --filter @workspace/shadow-garden run build` → puts frontend into `artifacts/shadow-garden/dist/public`
- `node artifacts/api-server/build.mjs` → esbuild bundles backend, then copies frontend into `artifacts/api-server/dist/public`
- Full rebuild: `cd artifacts/api-server && pnpm run build`

## Baileys version
- @whiskeysockets/baileys pinned to `7.0.0-rc13` (rc.9 is blocked by Replit package firewall).

## Identity source-of-truth
- Plain phone number (digits only, no @suffix) is the canonical user ID everywhere.
- LID resolution in message.ts and auth.ts; `resolvedMentions` pre-resolves @lid in CommandContext.

## Key decisions
- `botreply` removed from `allowedDmCmds` — it requires mod+ perms, regular DM users should be silently ignored.
- Duplicate `speech` block removed from converter.ts (real handler at top returns; stub at ~line 187 was dead code).
- `render.yaml` exists at repo root; uses `/data` persistent disk for SQLite + WhatsApp auth session.

## Render deployment notes
- Set DATA_DIR=/data env var; SQLite lives at /data/tenku.db (survives redeploys via disk).
- WhatsApp auth session is also in /data — must pair bot once after first deploy.
- Health check: GET /healthz
