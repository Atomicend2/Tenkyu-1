---
name: Tenku registration flow
description: How WA account linking works; critical LID dedup fix; .reg/.link/.verify spec.
---

## Registration spec (implemented)
- `.reg <phone>` → generates 6-digit OTP, stores in `whatsapp_link_otps` keyed by `wa_sender`, sends OTP to CURRENT WA chat
- `.verify <otp>` → validates OTP, resolves LID ghost row conflict, merges/creates phone-keyed user row
- `.link <otp>` (6-digit arg) → re-dispatches to .verify
- `.link <phone>` (10-15 digit arg) → old backup flow: sends OTP to claimed phone's DM
- No phone arg on `.reg` → falls through to handleEconomy (shows instructions)

## Critical bug fixed: LID unique constraint in .verify
**Problem:** `idx_users_lid` is a UNIQUE index on `users.lid WHERE lid IS NOT NULL`. When `.verify` tries to set `lid` on a web-registered row, it crashes if a ghost LID-keyed row already owns that LID.

**Fix in message.ts verify case:** Before ANY DB write that touches `lid`, find ghost row with matching LID (registered=0, id≠phone) → migrate its child records → DELETE it. Only then do the UPDATE/INSERT on the phone-keyed row.

**Why:** WhatsApp creates ghost rows the first time a user sends a message in a group (keyed by their LID). Web registration creates a separate row keyed by phone. The verify step must safely merge these two rows.

## DB tables for registration
- `whatsapp_link_otps`: `wa_sender TEXT PK, phone TEXT, code TEXT, expires_at INTEGER` — WA OTPs only (not web login OTPs)
- `web_otps`: separate table for web login OTPs
- `web_sessions`: web session tokens (30-day expiry)
- `users.lid`: digits-only LID with UNIQUE index (WHERE NOT NULL) — must dedup before setting

## Echidna
- Model: `anthropic/claude-3.5-sonnet` (was claude-sonnet-4-5 which may not be available)
- Requires `OPENROUTER_API_KEY` env secret — returns graceful "not configured" message if missing
- State persists in `bot_settings` table under key `echidna:state:<phone>`
