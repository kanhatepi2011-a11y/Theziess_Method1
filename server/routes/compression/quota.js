import {
  getCompressionQuota,
  reserveCompressionQuota,
} from "../_db.js";
import { getSession } from "../_session.js";

function errorStatus(code) {
  if (code === "SUBSCRIPTION_REQUIRED") return 403;
  if (code === "DAILY_FREE_LIMIT_REACHED") return 429;
  return 500;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate, max-age=0",
  );
  res.setHeader("Vary", "Cookie");

  try {
    const session = getSession(req);
    if (!session?.userId) {
      return res.status(401).json({
        ok: false,
        error: "Please log in with Telegram first.",
        code: "LOGIN_REQUIRED",
      });
    }

    const quota = req.method === "POST"
      ? await reserveCompressionQuota(session.userId)
      : await getCompressionQuota(session.userId);

    return res.status(200).json({
      ok: true,
      allowed: req.method === "POST"
        ? true
        : quota.unlimited || quota.remaining > 0,
      quota,
    });
  } catch (error) {
    const code = error?.code || "COMPRESSION_QUOTA_FAILED";
    console.error("Compression quota error:", {
      method: req.method,
      code,
      message: error?.message,
    });

    return res.status(errorStatus(code)).json({
      ok: false,
      allowed: false,
      error: error?.message || "Unable to check compression quota.",
      code,
      quota: error?.quota || null,
    });
  }
}
