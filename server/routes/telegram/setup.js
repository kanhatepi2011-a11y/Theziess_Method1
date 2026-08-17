import crypto from "node:crypto";

import { getPublicAppOrigin, getHeaderValue } from "../_telegram.js";
import {
  getTelegramAdminIds,
  getTelegramBotToken,
  getTelegramConfigStatus,
  getTelegramSetupKey,
  getTelegramWebhookSecret,
  safeEqual,
  telegramApi,
} from "../_telegram-bot.js";

const ADMIN_COMMANDS = [
  { command: "admin", description: "Open the admin dashboard" },
  { command: "stats", description: "Show platform statistics" },
  { command: "topcompress", description: "Show top compression users" },
  { command: "users", description: "List registered users" },
  { command: "user", description: "Show one user's full information" },
  { command: "subscriptions", description: "Show active paid plans" },
  { command: "grant", description: "Assign PRO, PREMIUM, or MAX to a user" },
  { command: "revoke", description: "Remove a user's active paid plan" },
  { command: "plans", description: "Show subscription assignment help" },
  { command: "trials", description: "Show active free trials" },
  { command: "payments", description: "Show recent payments" },
  { command: "maintenance", description: "Control website maintenance" },
  { command: "id", description: "Show your Telegram ID" },
  { command: "ping", description: "Test whether the bot is online" },
  { command: "testwelcome", description: "Preview the group welcome message" },
];

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

function getProvidedSetupKey(req) {
  const body = readBody(req);
  return String(
    body.setupKey ||
      req.query?.key ||
      getHeaderValue(req, "x-telegram-setup-key") ||
      "",
  ).trim();
}

function validateManualSetupKey(req) {
  const configuredKey = getTelegramSetupKey({ required: false });
  if (!configuredKey) return true;

  // Same-origin automatic bootstrap is allowed without exposing the setup key.
  const automatic = getHeaderValue(req, "x-theziess-auto-setup") === "1";
  if (automatic) return true;

  return safeEqual(getProvidedSetupKey(req), configuredKey);
}

const BOT_CONFIGURATION_VERSION = "telegram-admin-v13";

function webhookVersion(secret, token, adminIds) {
  return crypto
    .createHash("sha256")
    .update(`${BOT_CONFIGURATION_VERSION}:${secret}:${token.slice(0, 12)}:${adminIds.join(",")}`)
    .digest("hex")
    .slice(0, 12);
}

export async function ensureTelegramWebhook(req, { force = false } = {}) {
  const token = getTelegramBotToken();
  const webhookSecret = getTelegramWebhookSecret();

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must contain only letters, numbers, _ or -.",
    );
  }

  const origin = getPublicAppOrigin(req);
  const adminIds = [...getTelegramAdminIds()].sort();
  const version = webhookVersion(webhookSecret, token, adminIds);
  const webhookUrl = `${origin}/api/telegram/webhook?v=${version}`;

  const [bot, currentWebhook] = await Promise.all([
    telegramApi("getMe"),
    telegramApi("getWebhookInfo"),
  ]);

  const shouldUpdate = force || currentWebhook.url !== webhookUrl;

  if (shouldUpdate) {
    await telegramApi("setWebhook", {
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
  }

  const commandSetup = [];

  if (shouldUpdate || force) {
    await telegramApi("setMyCommands", {
      commands: [
        { command: "start", description: "Start the bot" },
        { command: "id", description: "Show your Telegram ID" },
        { command: "ping", description: "Test whether the bot is online" },
        { command: "help", description: "Open bot help" },
        { command: "testwelcome", description: "Preview the group welcome message" },
      ],
    });

    for (const adminId of adminIds) {
      try {
        await telegramApi("setMyCommands", {
          commands: ADMIN_COMMANDS,
          scope: { type: "chat", chat_id: adminId },
        });
        commandSetup.push({ adminId, ok: true });
      } catch (error) {
        commandSetup.push({
          adminId,
          ok: false,
          error: error.message,
        });
      }
    }
  }

  const webhookInfo = shouldUpdate
    ? await telegramApi("getWebhookInfo")
    : currentWebhook;

  return {
    ok: true,
    bot: {
      id: String(bot.id),
      username: bot.username || null,
    },
    webhookUrl,
    webhookUpdated: shouldUpdate,
    pendingUpdates: webhookInfo.pending_update_count || 0,
    lastErrorMessage: webhookInfo.last_error_message || null,
    adminCommandSetup: commandSetup,
    configuration: getTelegramConfigStatus(),
  };
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  try {
    if (!validateManualSetupKey(req)) {
      return res.status(401).json({
        ok: false,
        error: "Invalid setup key",
      });
    }

    const force =
      req.method === "GET" ||
      String(req.query?.force || "") === "1" ||
      readBody(req).force === true;

    const result = await ensureTelegramWebhook(req, { force });
    return res.status(200).json(result);
  } catch (error) {
    console.error("Telegram setup error:", {
      message: error?.message,
      code: error?.code,
    });

    return res.status(500).json({
      ok: false,
      error: error.message,
      code: error?.code || "TELEGRAM_SETUP_FAILED",
      configuration: getTelegramConfigStatus(),
    });
  }
}
