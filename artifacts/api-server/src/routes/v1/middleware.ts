import { type Request, type Response, type NextFunction } from "express";
import { getDb } from "../../bot/db/database.js";

export interface AuthRequest extends Request {
  userId?: string;
  user?: any;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return;
  }

  const token = authHeader.slice(7);
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const session = db.prepare("SELECT * FROM web_sessions WHERE token = ? AND expires_at > ?").get(token, now) as any;

  if (!session) {
    res.status(401).json({ success: false, message: "Invalid or expired session" });
    return;
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as any;
  if (!user) {
    res.status(401).json({ success: false, message: "User not found" });
    return;
  }

  req.userId = session.user_id;
  req.user = user;
  next();
}

export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const session = db.prepare("SELECT * FROM web_sessions WHERE token = ? AND expires_at > ?").get(token, now) as any;
    if (session) {
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as any;
      if (user) {
        req.userId = session.user_id;
        req.user = user;
      }
    }
  }
  next();
}
