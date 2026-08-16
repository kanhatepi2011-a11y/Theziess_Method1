import activityCompression from "../server/routes/activity/compression.js";
import compressionQuota from "../server/routes/compression/quota.js";
import authLogout from "../server/routes/auth/logout.js";
import authMe from "../server/routes/auth/me.js";
import authTelegram from "../server/routes/auth/telegram.js";
import authTelegramCallback from "../server/routes/auth/telegram/callback.js";
import authTikTok from "../server/routes/auth/tiktok.js";
import authTikTokCallback from "../server/routes/auth/tiktok/callback.js";
import dbStatus from "../server/routes/db-status.js";
import subscriptionActivateDemo from "../server/routes/subscription/activate-demo.js";
import telegramHealth from "../server/routes/telegram/health.js";
import telegramSetup from "../server/routes/telegram/setup.js";
import telegramWebhook from "../server/routes/telegram/webhook.js";
import tiktokAccount from "../server/routes/tiktok/account.js";
import tiktokCheck from "../server/routes/tiktok/check.js";
import tiktokDisconnect from "../server/routes/tiktok/disconnect.js";
import tiktokUploadCancel from "../server/routes/tiktok/upload/cancel.js";
import tiktokUploadInit from "../server/routes/tiktok/upload/init.js";
import tiktokUploadStatus from "../server/routes/tiktok/upload/status.js";

const ROUTES = new Map([
  ["activity/compression", activityCompression],
  ["compression/quota", compressionQuota],
  ["auth/logout", authLogout],
  ["auth/me", authMe],
  ["auth/telegram", authTelegram],
  ["auth/telegram/callback", authTelegramCallback],
  ["auth/tiktok", authTikTok],
  ["auth/tiktok/callback", authTikTokCallback],
  ["db-status", dbStatus],
  ["subscription/activate-demo", subscriptionActivateDemo],
  ["telegram/health", telegramHealth],
  ["telegram/setup", telegramSetup],
  ["telegram/webhook", telegramWebhook],
  ["tiktok/account", tiktokAccount],
  ["tiktok/check", tiktokCheck],
  ["tiktok/disconnect", tiktokDisconnect],
  ["tiktok/upload/cancel", tiktokUploadCancel],
  ["tiktok/upload/init", tiktokUploadInit],
  ["tiktok/upload/status", tiktokUploadStatus],
]);

function normalizeRoute(req) {
  const catchAll = req.query?.route;

  if (Array.isArray(catchAll)) {
    return catchAll.map((part) => String(part)).join("/");
  }

  if (typeof catchAll === "string" && catchAll.trim()) {
    return catchAll.replace(/^\/+|\/+$/g, "");
  }

  try {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    return pathname.replace(/^\/api\/?/, "").replace(/^\/+|\/+$/g, "");
  } catch {
    return "";
  }
}

export default async function handler(req, res) {
  const route = normalizeRoute(req);
  const routeHandler = ROUTES.get(route);

  if (!routeHandler) {
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(404).json({
      ok: false,
      code: "API_ROUTE_NOT_FOUND",
      error: "API route not found.",
    });
  }

  return routeHandler(req, res);
}
