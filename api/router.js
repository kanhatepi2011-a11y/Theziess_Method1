import { getMaintenanceState } from "../server/routes/_db.js";
import activityCompression from "../server/routes/activity/compression.js";
import authLogout from "../server/routes/auth/logout.js";
import authMe from "../server/routes/auth/me.js";
import authTelegram from "../server/routes/auth/telegram.js";
import authTelegramCallback from "../server/routes/auth/telegram/callback.js";
import authTikTok from "../server/routes/auth/tiktok.js";
import authTikTokCallback from "../server/routes/auth/tiktok/callback.js";
import compressionQuota from "../server/routes/compression/quota.js";
import dbStatus from "../server/routes/db-status.js";
import maintenanceStatus from "../server/routes/maintenance/status.js";
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
    ["maintenance/status", maintenanceStatus],
    ["tiktok/account", tiktokAccount],
    ["tiktok/check", tiktokCheck],
    ["tiktok/disconnect", tiktokDisconnect],
    ["tiktok/upload/cancel", tiktokUploadCancel],
    ["tiktok/upload/init", tiktokUploadInit],
    ["tiktok/upload/status", tiktokUploadStatus],
]);

const MAINTENANCE_EXEMPT_ROUTES = new Set([
    "maintenance/status",
    "telegram/health",
    "telegram/setup",
    "telegram/webhook",
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

    if (!MAINTENANCE_EXEMPT_ROUTES.has(route)) {
        try {
            const maintenance = await getMaintenanceState();
            if (maintenance.enabled) {
                res.setHeader("Cache-Control", "private, no-store, max-age=0");
                res.setHeader("Retry-After", "60");
                return res.status(503).json({
                    ok: false,
                    code: "WEBSITE_UNDER_MAINTENANCE",
                    error: maintenance.message,
                    maintenance,
                });
            }
        } catch (error) {
            // Fail open so a database outage cannot become an accidental permanent
            // maintenance lock. Individual route error handling remains unchanged.
            console.error(
                "Maintenance guard unavailable:",
                error?.message || error,
            );
        }
    }

    return routeHandler(req, res);
}
