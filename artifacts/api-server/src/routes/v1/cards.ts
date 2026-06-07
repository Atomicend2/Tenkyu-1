import { Router } from "express";
import multer from "multer";
import { requireAuth, optionalAuth, type AuthRequest } from "./middleware.js";
import { getDb } from "../../bot/db/database.js";
import { getSocket, isSocketConnected } from "../../bot/connection.js";
import { getStaff } from "../../bot/db/queries.js";
import { logger } from "../../lib/logger.js";

const router = Router();
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const ANIMATED_TIERS = new Set(["T6", "TS", "TX", "TZ"]); // must match VIDEO_TIERS in utils.ts
const VALID_TIERS = ["T1","T2","T3","T4","T5","T6","TS","TX","TZ"];

// Serve card media BLOB from the database (image or video for animated tiers)
router.get("/:id/image", (req, res) => {
  const db = getDb();
  const card = db.prepare("SELECT image_data, tier FROM cards WHERE id = ?").get(req.params.id) as any;
  if (!card?.image_data) {
    res.status(404).end();
    return;
  }
  const isAnimated = ANIMATED_TIERS.has(card.tier);
  const contentType = isAnimated ? "video/mp4" : "image/jpeg";
  const buf: Buffer = Buffer.isBuffer(card.image_data) ? card.image_data : Buffer.from(card.image_data);
  const total = buf.length;

  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Accept-Ranges", "bytes");

  const rangeHeader = req.headers["range"];
  if (isAnimated && rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", chunkSize);
      res.end(buf.slice(start, end + 1));
      return;
    }
  }

  res.setHeader("Content-Length", total);
  res.end(buf);
});

function getCardCopyCount(db: any, cardId: string): number {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM user_cards WHERE card_id = ?").get(cardId) as any;
  return row?.cnt || 0;
}

function getCardOwner(db: any, cardId: string): { name: string; id: string } | null {
  const row = db.prepare(`
    SELECT u.id, u.name FROM user_cards uc
    JOIN users u ON u.id = uc.user_id
    WHERE uc.card_id = ?
    ORDER BY uc.obtained_at ASC LIMIT 1
  `).get(cardId) as any;
  return row ? { id: row.id, name: row.name || "Unknown" } : null;
}

router.get("/", optionalAuth, (req, res) => {
  const db = getDb();
  const { tier, series } = req.query as { tier?: string; series?: string };

  let query = "SELECT * FROM cards";
  const params: any[] = [];
  const conditions: string[] = [];

  if (tier) {
    conditions.push("tier = ?");
    params.push(tier);
  }
  if (series) {
    conditions.push("LOWER(series) LIKE LOWER(?)");
    params.push(`%${series}%`);
  }
  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }
  query += " ORDER BY tier, name";

  const cards = db.prepare(query).all(...params) as any[];

  const result = cards.map((card: any) => {
    const owner = getCardOwner(db, card.id);
    const totalCopies = getCardCopyCount(db, card.id);
    const owners = db.prepare(`
      SELECT DISTINCT u.id, u.name FROM user_cards uc
      JOIN users u ON u.id = uc.user_id
      WHERE uc.card_id = ?
      LIMIT 5
    `).all(card.id) as any[];
    const isAnimated = ANIMATED_TIERS.has(card.tier);
    return {
      id: card.id,
      name: card.name,
      tier: card.tier,
      series: card.series || "General",
      description: card.description || "",
      imageUrl: card.image_data ? `/api/v1/cards/${card.id}/image` : (card.image_url || ""),
      isAnimated,
      totalCopies,
      ownerName: owner?.name || "Unclaimed",
      ownerId: owner?.id || null,
      owners: owners.map((o: any) => ({ id: o.id, name: o.name || "Shadow" })),
    };
  });

  res.json({ cards: result, total: result.length });
});

router.get("/my", requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const userCards = db.prepare(`
    SELECT uc.id as user_card_id, uc.obtained_at, c.*
    FROM user_cards uc
    JOIN cards c ON c.id = uc.card_id
    WHERE uc.user_id = ?
    ORDER BY uc.obtained_at DESC
  `).all(req.userId!) as any[];

  const result = userCards.map((uc: any) => {
    const totalCopies = getCardCopyCount(db, uc.id);
    const owners = db.prepare(`
      SELECT DISTINCT u.id, u.name FROM user_cards ucc
      JOIN users u ON u.id = ucc.user_id
      WHERE ucc.card_id = ?
      LIMIT 5
    `).all(uc.id) as any[];
    const isAnimated = ANIMATED_TIERS.has(uc.tier);
    return {
      userCardId: uc.user_card_id,
      card: {
        id: uc.id,
        name: uc.name,
        tier: uc.tier,
        series: uc.series || "General",
        description: uc.description || "",
        imageUrl: uc.image_data ? `/api/v1/cards/${uc.id}/image` : (uc.image_url || ""),
        isAnimated,
        totalCopies,
        ownerName: req.user?.name || "You",
        ownerId: req.userId,
        owners: owners.map((o: any) => ({ id: o.id, name: o.name || "Shadow" })),
      },
      obtainedAt: uc.obtained_at || 0,
    };
  });

  res.json({ cards: result, total: result.length });
});

router.post("/wishlist", requireAuth, async (req: AuthRequest, res) => {
  const { cardId } = req.body as { cardId?: string };
  if (!cardId) {
    res.status(400).json({ success: false, message: "cardId is required" });
    return;
  }

  const db = getDb();
  const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as any;
  if (!card) {
    res.status(404).json({ success: false, message: "Card not found" });
    return;
  }

  const owner = getCardOwner(db, cardId);
  if (!owner) {
    res.json({ success: true, message: "Card is unclaimed — no owner to notify" });
    return;
  }

  const sock = getSocket();
  if (sock && isSocketConnected() && owner.id !== req.userId) {
    try {
      const requesterName = req.user?.name || "Someone";
      await sock.sendMessage(owner.id, {
        text: `*Tenku 天空 — Trade Alert*\n\n${requesterName} wants to trade for your *${card.name}* (${card.tier} - ${card.series || "General"}).\n\nReply with .trade to negotiate.`,
      });
    } catch (err) {
      logger.error({ err }, "Failed to send wishlist notification");
    }
  }

  res.json({ success: true, message: "Trade notification sent to card owner" });
});

// ── Web card upload (staff only) ────────────────────────────────────────────
// POST /api/v1/cards/upload  — multipart: file (image or video), tier, name, series
router.post("/upload", requireAuth, uploadMem.single("file"), async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: "Not authenticated" }); return; }

    // Check staff / mod permission
    const staffRow = getStaff(userId);
    const BOT_OWNER = (process.env["OWNER_NUMBERS"] || process.env["BOT_OWNER_LID"] || "2348144550593").split(",")[0].replace(/\D/g, "");
    const isStaff = !!staffRow || userId.replace(/\D/g, "") === BOT_OWNER;
    if (!isStaff) {
      res.status(403).json({ success: false, message: "Only staff can upload cards." });
      return;
    }

    if (!req.file) { res.status(400).json({ success: false, message: "No file provided" }); return; }

    const tier = (req.body?.tier || "").toUpperCase().trim();
    const name = (req.body?.name || "").trim();
    const series = (req.body?.series || "").trim();

    if (!VALID_TIERS.includes(tier)) {
      res.status(400).json({ success: false, message: `Invalid tier. Valid: ${VALID_TIERS.join(", ")}` });
      return;
    }
    if (!name || name.length < 2) {
      res.status(400).json({ success: false, message: "Card name is required (min 2 chars)" });
      return;
    }
    if (!series || series.length < 2) {
      res.status(400).json({ success: false, message: "Series name is required" });
      return;
    }

    const db = getDb();
    const existing = db.prepare("SELECT id FROM cards WHERE LOWER(name) = LOWER(?)").get(name) as any;
    if (existing) {
      res.status(409).json({ success: false, message: `A card named "${name}" already exists (ID: ${existing.id}).` });
      return;
    }

    const isAnimated = ANIMATED_TIERS.has(tier);
    const mimeType = req.file.mimetype;
    const isVideo = mimeType.startsWith("video/");

    // For animated tiers accept video; for static tiers accept image
    if (isAnimated && !isVideo && !mimeType.startsWith("image/")) {
      res.status(400).json({ success: false, message: "Animated tier cards require a video or image file." });
      return;
    }
    if (!isAnimated && isVideo) {
      res.status(400).json({ success: false, message: `Tier ${tier} is not animated. Please upload an image.` });
      return;
    }

    let imageData: Buffer = req.file.buffer;

    // Optionally resize static images to save DB space
    if (!isVideo) {
      try {
        const sharp = (await import("sharp")).default;
        imageData = await sharp(req.file.buffer)
          .resize(800, 1100, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 92 })
          .toBuffer();
      } catch { /* sharp not available or unsupported format — use raw */ }
    }

    const result = db.prepare(
      "INSERT INTO cards (name, series, tier, image_data, is_animated, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(name, series, tier, imageData, isAnimated ? 1 : 0, userId);

    const cardId = result.lastInsertRowid;

    res.json({
      success: true,
      message: `Card uploaded! 🎴 ${name} (${tier}) — ${series}`,
      card: { id: cardId, name, series, tier, isAnimated },
    });
  } catch (err: any) {
    logger.error({ err }, "Card upload error");
    res.status(500).json({ success: false, message: err?.message || "Upload failed" });
  }
});


// ── Shoob.gg card import (staff only) ────────────────────────────────────────
// POST /api/v1/cards/fetch-shoob  — scrapes cards from shoob.gg and imports them
// Body: { tier, series, limit? }
router.post("/fetch-shoob", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: "Not authenticated" }); return; }

    const staffRow = getStaff(userId);
    const BOT_OWNER = (process.env["OWNER_NUMBERS"] || process.env["BOT_OWNER_LID"] || "2348144550593").split(",")[0].replace(/\D/g, "");
    const isStaff = !!staffRow || userId.replace(/\D/g, "") === BOT_OWNER;
    if (!isStaff) { res.status(403).json({ success: false, message: "Only staff can import cards." }); return; }

    const tier = ((req.body?.tier || "T3") as string).toUpperCase().trim();
    const series = ((req.body?.series || "Shoob") as string).trim();
    const limit = Math.min(parseInt(req.body?.limit || "20", 10) || 20, 50);
    const page = Math.max(1, parseInt(req.body?.page || "1", 10) || 1);

    if (!VALID_TIERS.includes(tier)) {
      res.status(400).json({ success: false, message: `Invalid tier. Valid: ${VALID_TIERS.join(", ")}` });
      return;
    }

    const db = getDb();
    const isAnimated = ANIMATED_TIERS.has(tier);

    // Fetch Shoob.gg card list
    const shoobRes = await fetch(`https://shoob.gg/api/cards?limit=100&page=${page}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TenkuBot/1.0)" },
      signal: AbortSignal.timeout(15000),
    });

    if (!shoobRes.ok) {
      res.status(502).json({ success: false, message: `Shoob.gg API returned ${shoobRes.status}` });
      return;
    }

    const shoobData: any = await shoobRes.json();
    // Shoob returns { cards: [...] } or just an array
    const rawCards: any[] = Array.isArray(shoobData) ? shoobData : (shoobData.cards || shoobData.data || []);

    if (!rawCards.length) {
      res.status(502).json({ success: false, message: "No cards returned from Shoob.gg" });
      return;
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const sc of rawCards.slice(0, limit)) {
      const cardName: string = (sc.name || sc.title || sc.card_name || "").trim();
      const cardSeries: string = (sc.series || sc.anime || sc.source || series).trim() || series;
      const mediaUrl: string = sc.image || sc.imageUrl || sc.image_url || sc.video || sc.videoUrl || sc.media_url || "";
      const isVideo = mediaUrl.match(/\.(mp4|webm|mov)(\?|$)/i) != null;

      if (!cardName || cardName.length < 2) { skipped++; continue; }

      // Skip if already exists
      const existing = db.prepare("SELECT id FROM cards WHERE LOWER(name) = LOWER(?)").get(cardName) as any;
      if (existing) { skipped++; continue; }

      let imageData: Buffer | null = null;
      if (mediaUrl) {
        try {
          const mediaRes = await fetch(mediaUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; TenkuBot/1.0)" },
            signal: AbortSignal.timeout(20000),
          });
          if (mediaRes.ok) {
            const buf = Buffer.from(await mediaRes.arrayBuffer());
            if (!isVideo) {
              try {
                const sharp = (await import("sharp")).default;
                imageData = await sharp(buf)
                  .resize(800, 1100, { fit: "inside", withoutEnlargement: true })
                  .jpeg({ quality: 92 })
                  .toBuffer();
              } catch { imageData = buf; }
            } else {
              imageData = buf;
            }
          }
        } catch (e: any) {
          errors.push(`${cardName}: ${e?.message || "fetch failed"}`);
        }
      }

      const cardTier = tier;
      const cardIsAnimated = isVideo ? 1 : (isAnimated ? 1 : 0);
      db.prepare(
        "INSERT INTO cards (name, series, tier, image_data, is_animated, uploaded_by, source) VALUES (?, ?, ?, ?, ?, ?, 'shoob.gg')"
      ).run(cardName, cardSeries, cardTier, imageData, cardIsAnimated, userId);
      imported++;
    }

    res.json({
      success: true,
      message: `Shoob.gg import complete: ${imported} imported, ${skipped} skipped.`,
      imported,
      skipped,
      errors: errors.slice(0, 10),
    });
  } catch (err: any) {
    logger.error({ err }, "Shoob fetch error");
    res.status(500).json({ success: false, message: err?.message || "Fetch failed" });
  }
});

export { router as cardsRouter };
