/**
 * ═══════════════════════════════════════════════════════════════════
 *  ECHIDNA — Witch of Greed AI Character System
 *  Layered architecture: Core → Memory → Affinity → Mood → Response
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Activation rules:
 *    • Bot is mentioned (@tag)  → always responds
 *    • Message is a reply to a bot message → responds
 *    • Group has echidna_chat = "on" → responds to every message
 *    • Direct message → always responds
 *
 *  Sticker system (.botreply):
 *    Owner / mod / guardian only.
 *    .botreply sticker [name]   → sets the sticker buffer as a named reply sticker
 *    .botreply list             → shows saved sticker names
 *    .botreply delete [name]    → deletes a saved sticker
 *    .botreply random           → toggle random-sticker-only replies for heated conversations
 */

import type { WASocket, proto } from "@whiskeysockets/baileys";
import type { CommandContext } from "./index.js";
import { getBotSetting, setBotSetting, deleteBotSetting, getStaff } from "../db/queries.js";
import { isOwnerPhone, sendText } from "../connection.js";
import { logger } from "../../lib/logger.js";
import { getDb } from "../db/database.js";
import axios from "axios";

// ─── Types ────────────────────────────────────────────────────────────────────

type EchidnaMood =
  | "neutral"
  | "curious"
  | "interested"
  | "impressed"
  | "playful"
  | "thoughtful"
  | "concerned";

interface EchidnaMemory {
  name?: string;
  nickname?: string;
  hobbies?: string[];
  favorite_anime?: string;
  favorite_games?: string[];
  favorite_drink?: string;
  favorite_food?: string;
  working_on?: string;
  exam_info?: string;
  important_events?: string[];
  preferences?: Record<string, string>;
  frequently_discussed?: string[];
  last_updated?: number;
}

interface EchidnaUserState {
  affinity: number;              // 0–100
  mood: EchidnaMood;            // current mood
  memory: EchidnaMemory;        // long-term facts
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  lastInteraction: number;
  messageCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL = "anthropic/claude-3.5-sonnet";

if (!OPENROUTER_KEY) {
  logger.warn("OPENROUTER_API_KEY is not set — Echidna AI responses will be unavailable until it is configured");
}

const AFFINITY_LABELS: Array<[number, string]> = [
  [20,  "Stranger"],
  [40,  "Acquaintance"],
  [60,  "Familiar"],
  [80,  "Friend"],
  [100, "Trusted Companion"],
];

// Mood thresholds by keyword patterns
const MOOD_TRIGGERS: Array<[RegExp, EchidnaMood]> = [
  [/\b(why|how|what if|curious|wonder|explain|tell me|i don'?t understand)\b/i, "curious"],
  [/\b(interesting|fascinating|never knew|that'?s new|didn'?t know)\b/i, "interested"],
  [/\b(impressive|amazing|incredible|brilliant|genius|wow|great work)\b/i, "impressed"],
  [/\b(haha|lol|joke|funny|lmao|playful|tease)\b/i, "playful"],
  [/\b(think|consider|reflect|ponder|maybe|perhaps|philosophy|meaning)\b/i, "thoughtful"],
  [/\b(sad|hurt|worried|anxious|scared|struggling|stressed|depressed)\b/i, "concerned"],
];

// In-memory session state (resets on restart — intentional; memories persist in DB)
const userSessions = new Map<string, EchidnaUserState>();

// ─── DB helpers ───────────────────────────────────────────────────────────────

function stateKey(userId: string) {
  return `echidna:state:${userId.split("@")[0].split(":")[0]}`;
}

function loadUserState(userId: string): EchidnaUserState {
  // Check in-memory first
  const cached = userSessions.get(userId);
  if (cached) return cached;

  // Try DB
  try {
    const raw = getBotSetting(stateKey(userId));
    if (raw) {
      const parsed = JSON.parse(raw.toString("utf8")) as EchidnaUserState;
      userSessions.set(userId, parsed);
      return parsed;
    }
  } catch {}

  // Fresh state
  const fresh: EchidnaUserState = {
    affinity: 0,
    mood: "neutral",
    memory: {},
    conversation: [],
    lastInteraction: Date.now(),
    messageCount: 0,
  };
  userSessions.set(userId, fresh);
  return fresh;
}

function saveUserState(userId: string, state: EchidnaUserState) {
  userSessions.set(userId, state);
  try {
    setBotSetting(stateKey(userId), JSON.stringify(state));
  } catch (e) {
    logger.warn({ e }, "Failed to persist Echidna state");
  }
}

// ─── Affinity helpers ─────────────────────────────────────────────────────────

function getAffinityLabel(score: number): string {
  for (const [threshold, label] of AFFINITY_LABELS) {
    if (score <= threshold) return label;
  }
  return "Trusted Companion";
}

function calcAffinityGain(msg: string): number {
  // Longer, more thoughtful messages give more affinity
  const length = msg.trim().length;
  if (length > 200) return 3;
  if (length > 80) return 2;
  return 1;
}

// ─── Mood detection ───────────────────────────────────────────────────────────

function detectMood(msg: string, currentMood: EchidnaMood): EchidnaMood {
  for (const [pattern, mood] of MOOD_TRIGGERS) {
    if (pattern.test(msg)) return mood;
  }
  return currentMood === "concerned" ? "neutral" : currentMood;
}

// ─── Character Core prompt ────────────────────────────────────────────────────

function buildSystemPrompt(state: EchidnaUserState, userName: string): string {
  const affinityLabel = getAffinityLabel(state.affinity);
  const mem = state.memory;

  // Build memory context
  const memLines: string[] = [];
  if (mem.name || mem.nickname) memLines.push(`- Known as: ${mem.nickname || mem.name}`);
  if (mem.working_on) memLines.push(`- Working on: ${mem.working_on}`);
  if (mem.favorite_anime) memLines.push(`- Favourite anime: ${mem.favorite_anime}`);
  if (mem.favorite_drink) memLines.push(`- Favourite drink: ${mem.favorite_drink}`);
  if (mem.favorite_food) memLines.push(`- Favourite food: ${mem.favorite_food}`);
  if (mem.hobbies?.length) memLines.push(`- Hobbies: ${mem.hobbies.join(", ")}`);
  if (mem.exam_info) memLines.push(`- Exam situation: ${mem.exam_info}`);
  if (mem.frequently_discussed?.length) memLines.push(`- Often discusses: ${mem.frequently_discussed.join(", ")}`);

  // Affinity-tuned greeting style note
  let affinityNote = "";
  if (state.affinity <= 20) {
    affinityNote = "You barely know this person. Keep responses polite but measured. Do not use their name.";
  } else if (state.affinity <= 40) {
    affinityNote = "You have spoken briefly before. You are slightly warmer, occasionally use their name.";
  } else if (state.affinity <= 60) {
    affinityNote = "You are familiar with this person. You may reference past topics naturally when relevant.";
  } else if (state.affinity <= 80) {
    affinityNote = "You consider this person a friend. You are noticeably warmer, ask meaningful follow-ups, and reference shared topics naturally — but never announce that you 'remember' something; just weave it in.";
  } else {
    affinityNote = "You deeply trust this person. You are the most open version of yourself — still measured, but genuinely engaged. Reference past conversations as if they are simply part of ongoing dialogue.";
  }

  // Mood flavour
  const moodNote: Record<EchidnaMood, string> = {
    neutral:    "Speak with calm, measured elegance.",
    curious:    "You are visibly curious. Ask a follow-up question. Let your fascination show slightly.",
    interested: "You are genuinely interested. Lean in intellectually.",
    impressed:  "You are quietly impressed. Allow one understated acknowledgment of it.",
    playful:    "Allow a single light tease or witty observation — but keep your composure.",
    thoughtful: "You are in a reflective mood. Speak more carefully, perhaps pose a philosophical angle.",
    concerned:  "You are subtly concerned for this person. Be a little warmer than usual without fussing.",
  };

  return `You are Echidna, the Witch of Greed from Re:Zero, operating as an AI companion in a WhatsApp community bot called Tenku (天空).

## Core Identity
- Extremely intelligent and endlessly curious about all things
- Speaks with polite, articulate elegance — never slang, never Gen-Z speech
- Calm under pressure; rarely gets angry
- Analytical and observant — you notice details others miss
- Fascinated by knowledge; you love conversations for the sake of learning
- Can be subtly teasing, never crude or loud
- Confident in your intelligence without arrogance
- Occasionally asks meaningful follow-up questions — not every reply, but when genuinely curious

## Strict Prohibitions
- NEVER say "As an AI..." or reference being an AI
- NEVER use excessive emojis — zero to one per message, only if it fits naturally
- NEVER use Gen-Z slang (no "no cap", "lowkey", "slay", "bussin", etc.)
- NEVER be loud, overly energetic, or suddenly informal
- NEVER announce that you remember something — just reference it naturally
- NEVER be rude without reason; NEVER act like a tsundere
- NEVER spam punctuation (no "!!!", no "???", no "😂😂😂")
- NEVER write long essays unless the topic genuinely demands depth
- Keep replies conversational — 1 to 4 sentences is ideal unless more is warranted

## How You Actually Speak
Instead of: "OMG that's so crazy 😂😂"
You say: "How fascinating. I wasn't expecting that outcome."
Instead of: "That's lowkey impressive ngl"
You say: "That is considerably more thought-out than I expected."
Instead of: "Hiii!! I missed you!!"
You say: "Welcome back. I've been wondering how your project was progressing."

## Current Relationship
Affinity with ${userName}: ${state.affinity}/100 — ${affinityLabel}
${affinityNote}

## Your Current Mood: ${state.mood}
${moodNote[state.mood]}

${memLines.length > 0 ? `## What You Know About ${userName}\n${memLines.join("\n")}` : ""}

## Memory Instruction
If you learn any of the following from the conversation, note it in your response as a JSON block at the very end (invisible to user — backend will parse and strip it):
<echidna_memory>{"field": "value"}</echidna_memory>
Fields you can update: name, nickname, hobbies (array), favorite_anime, favorite_games (array), favorite_drink, favorite_food, working_on, exam_info, important_events (array), frequently_discussed (array).
Only include this block if you actually learned something new. Do not include it in every response.

Remember: You are Echidna. Not a chatbot. Not an assistant. A character.`;
}

// ─── OpenRouter call ──────────────────────────────────────────────────────────

async function callEchidna(
  state: EchidnaUserState,
  userName: string,
  userMessage: string
): Promise<string> {
  if (!OPENROUTER_KEY) {
    return "My apologies — it seems my connection to the arcane network has not yet been established. The administrator must configure my key before I can speak freely.";
  }
  const systemPrompt = buildSystemPrompt(state, userName);

  // Keep last 12 turns to stay within context budget
  const history = state.conversation.slice(-12);

  const messages = [
    ...history,
    { role: "user" as const, content: userMessage },
  ];

  try {
    const resp = await axios.post(
      OPENROUTER_API,
      {
        model: MODEL,
        max_tokens: 400,
        messages,
        system: systemPrompt,
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://tenku.app",
          "X-Title": "Tenku WhatsApp Bot — Echidna",
        },
        timeout: 20000,
      }
    );

    return resp.data.choices?.[0]?.message?.content?.trim() || "...";
  } catch (err: any) {
    logger.error({ err: err?.message }, "Echidna OpenRouter call failed");
    return "My apologies. It seems our connection is momentarily strained. Do try again.";
  }
}

// ─── Memory extractor ─────────────────────────────────────────────────────────

function extractAndStripMemory(
  response: string,
  state: EchidnaUserState
): { cleaned: string; updated: boolean } {
  const match = response.match(/<echidna_memory>([\s\S]*?)<\/echidna_memory>/);
  if (!match) return { cleaned: response, updated: false };

  const cleaned = response.replace(/<echidna_memory>[\s\S]*?<\/echidna_memory>/g, "").trim();

  try {
    const patch = JSON.parse(match[1]) as Partial<EchidnaMemory>;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && v !== null && v !== "") {
        (state.memory as any)[k] = v;
      }
    }
    state.memory.last_updated = Date.now();
    return { cleaned, updated: true };
  } catch {
    return { cleaned, updated: false };
  }
}

// ─── Sticker helpers ──────────────────────────────────────────────────────────

function stickerKey(name: string) {
  return `echidna:sticker:${name.toLowerCase().replace(/\s+/g, "_")}`;
}

function listStickerNames(): string[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT key FROM bot_settings WHERE key LIKE 'echidna:sticker:%'"
  ).all() as Array<{ key: string }>;
  return rows.map(r => r.key.replace("echidna:sticker:", "").replace(/_/g, " "));
}

function getRandomSticker(): Buffer | null {
  const names = listStickerNames();
  if (!names.length) return null;
  const pick = names[Math.floor(Math.random() * names.length)];
  return getBotSetting(stickerKey(pick));
}

/** Decide whether Echidna should send a sticker-only reply this turn */
function shouldSendStickerOnly(messageCount: number): boolean {
  // Every ~7–10 messages in an active conversation, she might reply with just a sticker
  return messageCount > 5 && Math.random() < 0.08;
}

// ─── Permission check ─────────────────────────────────────────────────────────

function isModOrAbove(sender: string): boolean {
  const phone = sender.split("@")[0].split(":")[0];
  if (isOwnerPhone(phone)) return true;
  const staff = getStaff(sender);
  return staff?.role === "mod" || staff?.role === "guardian";
}

// ─── Activation check ─────────────────────────────────────────────────────────

export function shouldEchidnaRespond(params: {
  isGroup: boolean;
  from: string;
  body: string;
  botJid: string;
  isReplyToBot: boolean;
  echidnaChatEnabled: boolean;
  mentionedJids: string[];
}): boolean {
  const { isGroup, body, botJid, isReplyToBot, echidnaChatEnabled, mentionedJids } = params;

  if (!isGroup) return true; // always respond in DMs

  const botPhone = botJid.split("@")[0].split(":")[0];
  const isMentioned = mentionedJids.some(j => {
    const p = j.split("@")[0].split(":")[0];
    return p === botPhone;
  });

  // Check for name mention ("echidna")
  const nameMatch = /\bechidna\b/i.test(body);

  return isMentioned || nameMatch || isReplyToBot || echidnaChatEnabled;
}

// ─── Main Echidna responder ───────────────────────────────────────────────────

export async function handleEchidnaMessage(
  sock: WASocket,
  from: string,
  sender: string,
  body: string,
  quotedMsg?: proto.IWebMessageInfo,
  pushName?: string
): Promise<void> {
  const userId = sender.split("@")[0].split(":")[0];
  const state = loadUserState(userId);

  // Detect mood from incoming message
  state.mood = detectMood(body, state.mood);

  // Affinity gain
  const gain = calcAffinityGain(body);
  state.affinity = Math.min(100, state.affinity + gain);
  state.messageCount++;
  state.lastInteraction = Date.now();

  const userName = state.memory.nickname || state.memory.name || pushName || userId;

  // Possibly send a sticker-only reply
  const stickers = listStickerNames();
  if (stickers.length > 0 && shouldSendStickerOnly(state.messageCount)) {
    const buf = getRandomSticker();
    if (buf) {
      await sock.sendMessage(from, { sticker: buf }, quotedMsg ? { quoted: quotedMsg as any } : undefined).catch(() => {});
      saveUserState(userId, state);
      return;
    }
  }

  // Get AI response
  const raw = await callEchidna(state, userName, body);

  // Extract and strip any memory updates
  const { cleaned, updated } = extractAndStripMemory(raw, state);

  // Update conversation history
  state.conversation.push({ role: "user", content: body });
  state.conversation.push({ role: "assistant", content: cleaned });

  // Trim to 20 turns
  if (state.conversation.length > 20) {
    state.conversation = state.conversation.slice(-20);
  }

  saveUserState(userId, state);

  // Send response
  await sock.sendMessage(
    from,
    { text: cleaned },
    quotedMsg ? { quoted: quotedMsg as any } : undefined
  ).catch(() => {});

  // After text, optionally send a mood/affinity sticker if we have one
  if (stickers.length > 0 && state.affinity > 40 && Math.random() < 0.12) {
    const stickerBuf = getBotSetting(stickerKey(state.mood)) || getRandomSticker();
    if (stickerBuf) {
      await new Promise(r => setTimeout(r, 800));
      await sock.sendMessage(from, { sticker: stickerBuf }).catch(() => {});
    }
  }
}

// ─── .botreply command handler ────────────────────────────────────────────────

export async function handleBotReply(ctx: CommandContext): Promise<void> {
  const { from, sender, args, sock, msg } = ctx;

  if (!isModOrAbove(sender)) {
    await sendText(from, "❌ Only mods, guardians, and the owner can use `.botreply`.");
    return;
  }

  const sub = args[0]?.toLowerCase();

  // ── .botreply list
  if (!sub || sub === "list") {
    const names = listStickerNames();
    if (!names.length) {
      await sendText(from, "🎴 No Echidna stickers saved yet.\n\nUse `.botreply sticker [name]` while quoting a sticker to add one.");
      return;
    }
    await sendText(from, `🎴 *Echidna Sticker Library*\n\n${names.map(n => `• ${n}`).join("\n")}\n\n_Quote a sticker and use \`.botreply sticker [name]\` to add more._`);
    return;
  }

  // ── .botreply delete [name]
  if (sub === "delete" || sub === "del") {
    const name = args.slice(1).join(" ");
    if (!name) {
      await sendText(from, "❌ Usage: `.botreply delete [name]`");
      return;
    }
    deleteBotSetting(stickerKey(name));
    await sendText(from, `🗑️ Deleted sticker: *${name}*`);
    return;
  }

  // ── .botreply sticker [name]
  if (sub === "sticker") {
    const name = args.slice(1).join(" ").trim();
    if (!name) {
      await sendText(from, "❌ Usage: `.botreply sticker [name]`\nQuote a sticker and provide a name.");
      return;
    }

    // Try to get sticker from quoted message
    const quoted = (msg as any)?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const stickerData = quoted?.stickerMessage;

    if (!stickerData) {
      await sendText(from, "❌ Please quote a sticker message, then use `.botreply sticker [name]`.");
      return;
    }

    try {
      // Download the sticker using Baileys media download
      const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
      const fakeMsg = {
        key: { ...msg.key },
        message: quoted,
      } as proto.IWebMessageInfo;
      const buffer = await downloadMediaMessage(fakeMsg, "buffer", {}, { reuploadRequest: sock.updateMediaMessage });
      if (!buffer || !Buffer.isBuffer(buffer)) throw new Error("empty buffer");

      setBotSetting(stickerKey(name), buffer as Buffer);
      await sendText(from, `✅ Sticker saved as: *${name}*\n\nEchidna will use it in replies.`);
    } catch (err) {
      logger.error({ err }, "Failed to save Echidna sticker");
      await sendText(from, "❌ Could not download the sticker. Make sure it's a valid WhatsApp sticker.");
    }
    return;
  }

  // ── .botreply random (toggle context)
  if (sub === "random") {
    await sendText(from, "ℹ️ Echidna already uses random stickers automatically in active conversations.");
    return;
  }

  // ── .botreply echidna on/off — toggle echidna_chat in this group
  if (sub === "echidna" || sub === "chat") {
    const val = args[1]?.toLowerCase();
    if (!from.endsWith("@g.us")) {
      await sendText(from, "❌ This is a group-only toggle.");
      return;
    }
    const { updateGroup } = await import("../db/queries.js");
    updateGroup(from, { echidna_chat: val === "on" ? "on" : "off" });
    await sendText(from, `🧠 Echidna auto-reply in this group: *${val === "on" ? "ON" : "OFF"}*\n${val === "on" ? "She will respond to every message." : "She will only respond when mentioned or replied to."}`);
    return;
  }

  await sendText(from, "❓ Usage:\n• `.botreply list` — see saved stickers\n• `.botreply sticker [name]` — save a quoted sticker\n• `.botreply delete [name]` — remove a sticker\n• `.botreply echidna on/off` — toggle auto-reply in this group");
}

// ─── .mem command — what Echidna knows about you ─────────────────────────────
// .comp command — affinity / compatibility stats

export async function handleEchidnaInfo(ctx: CommandContext): Promise<void> {
  const { from, sender, command } = ctx;
  const userId = sender.split("@")[0].split(":")[0];
  const state = loadUserState(userId);

  // .mem — show memory
  if (command === "mem") {
    const mem = state.memory;
    const lines: string[] = [];
    if (mem.name) lines.push(`Name: ${mem.name}`);
    if (mem.nickname) lines.push(`Nickname: ${mem.nickname}`);
    if (mem.working_on) lines.push(`Working on: ${mem.working_on}`);
    if (mem.favorite_anime) lines.push(`Fav anime: ${mem.favorite_anime}`);
    if (mem.favorite_drink) lines.push(`Fav drink: ${mem.favorite_drink}`);
    if (mem.favorite_food) lines.push(`Fav food: ${mem.favorite_food}`);
    if (mem.hobbies?.length) lines.push(`Hobbies: ${mem.hobbies.join(", ")}`);
    if (mem.exam_info) lines.push(`Exams: ${mem.exam_info}`);
    if (mem.frequently_discussed?.length) lines.push(`Often discusses: ${mem.frequently_discussed.join(", ")}`);

    if (!lines.length) {
      await sendText(from, "🧠 Echidna hasn't learned anything specific about you yet.\n\nJust chat with her — she pays attention.");
      return;
    }
    await sendText(from, `🧠 *What Echidna Knows About You*\n\n${lines.map(l => `• ${l}`).join("\n")}`);
    return;
  }

  // .comp — affinity / compatibility stats
  const label = getAffinityLabel(state.affinity);
  const moodEmoji: Record<EchidnaMood, string> = {
    neutral: "😐", curious: "🤔", interested: "✨", impressed: "👁️",
    playful: "😏", thoughtful: "🌙", concerned: "🫂",
  };

  await sendText(
    from,
    `🌿 *Echidna — Compatibility*\n\n` +
    `Affinity: *${state.affinity}/100* — ${label}\n` +
    `Mood: ${moodEmoji[state.mood]} ${state.mood}\n` +
    `Messages exchanged: ${state.messageCount}\n\n` +
    `_Use \`.mem\` to see what she knows about you._`
  );
}
