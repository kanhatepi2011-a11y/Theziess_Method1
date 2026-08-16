import { getHeaderValue } from "../_telegram.js";

let databaseModulePromise;

function getDatabaseModule() {
  if (!databaseModulePromise) {
    databaseModulePromise = import("../_db.js").catch((error) => {
      databaseModulePromise = null;
      throw error;
    });
  }
  return databaseModulePromise;
}
import {
  answerTelegramCallback,
  escapeTelegramHtml,
  getTelegramWebhookSecret,
  isTelegramAdmin,
  safeEqual,
  sendTelegramMessage,
} from "../_telegram-bot.js";
import {
  buildTelegramWelcomeKeyboard,
  buildTelegramWelcomeMessage,
  getTelegramWelcomeConfig,
  isHumanTelegramMember,
  isTelegramGroupAdmin,
  resolveTelegramWelcomeAdmin,
} from "../_telegram-welcome.js";

const PAGE_SIZE = 8;

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

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.ADMIN_TIMEZONE || "Asia/Phnom_Penh",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const amount = bytes / 1024 ** index;
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function userName(user) {
  const name = [user?.first_name, user?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || user?.username || "Telegram User";
}

function usernameLabel(user) {
  return user?.username ? `@${user.username}` : "no username";
}

function planLabel(planId) {
  const labels = {
    free: "FREE Trial",
    pro: "PRO",
    premium: "PREMIUM",
    max: "MAX",
  };
  return labels[String(planId || "").toLowerCase()] || "No active plan";
}

function remainingLabel(expiresAt) {
  if (!expiresAt) return "No expiry date";
  const milliseconds = new Date(expiresAt).getTime() - Date.now();
  if (milliseconds <= 0) return "Expired";

  const hours = Math.ceil(milliseconds / (60 * 60 * 1000));
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} left`;
  const days = Math.ceil(hours / 24);
  return `${days} days left`;
}

function dashboardKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📊 Stats", callback_data: "admin:stats" },
        { text: "👥 Users", callback_data: "admin:users:1" },
      ],
      [
        { text: "💎 Subscriptions", callback_data: "admin:subscriptions" },
        { text: "🆓 Trials", callback_data: "admin:trials" },
      ],
      [
        { text: "🔄 Change Plan", callback_data: "admin:grant:help" },
      ],
      [{ text: "💳 Payments", callback_data: "admin:payments" }],
    ],
  };
}

async function buildStatsMessage() {
  const { getAdminStats } = await getDatabaseModule();
  const stats = await getAdminStats();

  return [
    "<b>📊 TheZiess Admin Statistics</b>",
    "",
    `👥 Total users: <b>${stats.total_users}</b>`,
    `🟢 Logged in (24h): <b>${stats.users_last_24h}</b>`,
    `💎 Active paid plans: <b>${stats.active_paid}</b>`,
    `🆓 Active free trials: <b>${stats.active_trials}</b>`,
    `🎬 Total compressions: <b>${stats.total_compressions}</b>`,
    `⚡ Compressions (24h): <b>${stats.compressions_last_24h}</b>`,
    `💳 Payment records: <b>${stats.total_payments}</b>`,
    `💰 Recorded amount: <b>${formatMoney(stats.total_payment_amount)}</b>`,
    "",
    `🕒 Updated: ${escapeTelegramHtml(formatDate(new Date()))}`,
  ].join("\n");
}

async function sendDashboard(chatId) {
  const { getAdminStats } = await getDatabaseModule();
  const stats = await getAdminStats();
  const message = [
    "<b>🛡 TheZiess Admin Panel</b>",
    "",
    `👥 Users: <b>${stats.total_users}</b>`,
    `💎 Paid: <b>${stats.active_paid}</b> · 🆓 Trials: <b>${stats.active_trials}</b>`,
    `🎬 Compressions: <b>${stats.total_compressions}</b>`,
    "",
    "Choose an admin section below.",
  ].join("\n");

  await sendTelegramMessage(chatId, message, {
    reply_markup: dashboardKeyboard(),
  });
}

async function sendUsers(chatId, requestedPage = 1) {
  const { listAdminUsers } = await getDatabaseModule();
  const result = await listAdminUsers({
    page: requestedPage,
    pageSize: PAGE_SIZE,
  });

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const page = Math.min(result.page, totalPages);

  if (page !== result.page && result.total > 0) {
    return sendUsers(chatId, page);
  }

  const lines = [
    `<b>👥 Users (${result.total})</b>`,
    `<i>Page ${page}/${totalPages}</i>`,
    "",
  ];

  if (result.users.length === 0) {
    lines.push("No registered users yet.");
  } else {
    result.users.forEach((user, index) => {
      const position = (page - 1) * result.pageSize + index + 1;
      lines.push(
        `${position}. <b>${escapeTelegramHtml(userName(user))}</b>`,
        `   ID: <code>${escapeTelegramHtml(user.telegram_id)}</code> · ${escapeTelegramHtml(usernameLabel(user))}`,
        `   Plan: <b>${escapeTelegramHtml(planLabel(user.active_plan_id))}</b> · Login: ${escapeTelegramHtml(formatDate(user.last_login_at))}`,
      );
    });
    lines.push("", "Use <code>/user TELEGRAM_ID</code> for full details.");
  }

  const navigation = [];
  if (page > 1) {
    navigation.push({ text: "⬅️ Previous", callback_data: `admin:users:${page - 1}` });
  }
  navigation.push({ text: "🏠 Admin", callback_data: "admin:home" });
  if (page < totalPages) {
    navigation.push({ text: "Next ➡️", callback_data: `admin:users:${page + 1}` });
  }

  await sendTelegramMessage(chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: [navigation] },
  });
}

async function sendUserDetails(chatId, lookup) {
  const {
    findAdminUser,
    getAdminUserCompressionStats,
    listAdminUserAccessHistory,
    listAdminUserCompressionEvents,
    listAdminUserPayments,
  } = await getDatabaseModule();
  const user = await findAdminUser(lookup);

  if (!user) {
    await sendTelegramMessage(
      chatId,
      "❌ User not found. Use <code>/user TELEGRAM_ID</code> or <code>/user @username</code>.",
    );
    return;
  }

  const [compression, compressionEvents, accessHistory, payments] =
    await Promise.all([
      getAdminUserCompressionStats(user.id),
      listAdminUserCompressionEvents(user.id, 5),
      listAdminUserAccessHistory(user.id, 6),
      listAdminUserPayments(user.id, 5),
    ]);

  const lines = [
    `<b>👤 ${escapeTelegramHtml(userName(user))}</b>`,
    "",
    `<b>Telegram information</b>`,
    `• Telegram ID: <code>${escapeTelegramHtml(user.telegram_id)}</code>`,
    `• Username: ${escapeTelegramHtml(usernameLabel(user))}`,
    `• Database ID: <code>${escapeTelegramHtml(user.id)}</code>`,
    `• Registered: ${escapeTelegramHtml(formatDate(user.created_at))}`,
    `• Last login: ${escapeTelegramHtml(formatDate(user.last_login_at))}`,
    "",
    `<b>Current access</b>`,
    `• Plan: <b>${escapeTelegramHtml(planLabel(user.active_plan_id))}</b>`,
    `• Started: ${escapeTelegramHtml(formatDate(user.active_starts_at))}`,
    `• Expires: ${escapeTelegramHtml(formatDate(user.active_expires_at))}`,
    `• Remaining: ${escapeTelegramHtml(user.active_plan_id ? remainingLabel(user.active_expires_at) : "—")}`,
    "",
    `<b>Compression activity</b>`,
    `• Total videos: <b>${compression.total_compressions}</b>`,
    `• Total input: ${escapeTelegramHtml(formatBytes(compression.total_input_bytes))}`,
    `• Total output: ${escapeTelegramHtml(formatBytes(compression.total_output_bytes))}`,
    `• Last compression: ${escapeTelegramHtml(formatDate(compression.last_compression_at))}`,
  ];

  if (compressionEvents.length) {
    lines.push("", "<b>Recent videos</b>");
    compressionEvents.forEach((event) => {
      lines.push(
        `• ${escapeTelegramHtml(event.output_name || event.input_name || "Video")} — ${escapeTelegramHtml(formatBytes(event.output_bytes))} — ${escapeTelegramHtml(formatDate(event.created_at))}`,
      );
    });
  }

  if (accessHistory.length) {
    lines.push("", "<b>Subscription history</b>");
    accessHistory.forEach((item) => {
      lines.push(
        `• ${escapeTelegramHtml(planLabel(item.plan_id))} · ${escapeTelegramHtml(item.status)} · ${escapeTelegramHtml(formatDate(item.starts_at))} → ${escapeTelegramHtml(formatDate(item.expires_at))}`,
      );
    });
  }

  if (payments.length) {
    lines.push("", "<b>Payment history</b>");
    payments.forEach((payment) => {
      lines.push(
        `• ${escapeTelegramHtml(planLabel(payment.plan_id))} · ${formatMoney(payment.amount_usd)} · ${escapeTelegramHtml(payment.status)} · ${escapeTelegramHtml(formatDate(payment.created_at))}`,
      );
    });
  }

  await sendTelegramMessage(chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🆓 Set FREE", callback_data: `admin:grant:${user.id}:free` },
        ],
        [
          { text: "⚡ Grant PRO", callback_data: `admin:grant:${user.id}:pro` },
          { text: "💎 Grant PREMIUM", callback_data: `admin:grant:${user.id}:premium` },
        ],
        [{ text: "👑 Grant MAX", callback_data: `admin:grant:${user.id}:max` }],
        [
          { text: "🚫 Revoke paid plan", callback_data: `admin:revoke:${user.id}` },
          { text: "🏠 Admin", callback_data: "admin:home" },
        ],
      ],
    },
  });
}

async function sendGrantHelp(chatId) {
  await sendTelegramMessage(
    chatId,
    [
      "<b>➕ Change user plan</b>",
      "",
      "Only a configured Telegram admin can change a user between FREE, PRO, PREMIUM, and MAX.",
      "",
      "<b>Commands</b>",
      "<code>/grant TELEGRAM_ID free</code>",
      "<code>/grant TELEGRAM_ID pro</code>",
      "<code>/grant TELEGRAM_ID premium</code>",
      "<code>/grant TELEGRAM_ID max</code>",
      "<code>/grant @username free</code>",
      "<code>/grant @username pro</code>",
      "",
      "<b>Plan durations</b>",
      "FREE: 3 days · max 3 videos/day",
      "PRO: 30 days",
      "PREMIUM: 180 days",
      "MAX: 1 year (365 days)",
      "",
      "You can also open <code>/user TELEGRAM_ID</code> and tap a plan button.",
      "",
      "To remove a paid plan: <code>/revoke TELEGRAM_ID</code>",
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [[{ text: "🏠 Admin", callback_data: "admin:home" }]],
      },
    },
  );
}

async function grantPlanToUser(chatId, lookup, planId, adminTelegramId) {
  const normalizedPlan = String(planId || "").trim().toLowerCase();
  const allowedPlans = new Set(["free", "pro", "premium", "max"]);

  if (!lookup || !allowedPlans.has(normalizedPlan)) {
    await sendTelegramMessage(
      chatId,
      "Usage: <code>/grant TELEGRAM_ID free</code>, <code>pro</code>, <code>premium</code>, or <code>max</code>.",
    );
    return;
  }

  try {
    const database = await getDatabaseModule();
    const { user, subscription } = normalizedPlan === "free"
      ? await database.setAdminFreePlan({
          lookup,
          adminTelegramId,
        })
      : await database.grantAdminSubscription({
          lookup,
          planId: normalizedPlan,
          adminTelegramId,
        });

    let userNotified = false;
    try {
      await sendTelegramMessage(
        user.telegram_id,
        [
          normalizedPlan === "free"
            ? "🆓 <b>Your TheZiess plan was changed to FREE</b>"
            : "✅ <b>Your TheZiess subscription is active</b>",
          "",
          `Plan: <b>${escapeTelegramHtml(planLabel(subscription.plan_id))}</b>`,
          `Expires: ${escapeTelegramHtml(subscription.expires_at ? formatDate(subscription.expires_at) : "No expiry date")}`,
          ...(normalizedPlan === "free"
            ? ["Daily limit: <b>3 videos/day</b>"]
            : []),
          "",
          "Open or refresh the website to use video compression.",
        ].join("\n"),
      );
      userNotified = true;
    } catch (notificationError) {
      console.warn("Subscription granted, but user notification failed:", {
        message: notificationError?.message,
        code: notificationError?.code,
      });
    }

    await sendTelegramMessage(
      chatId,
      [
        normalizedPlan === "free"
          ? "✅ <b>User changed to FREE</b>"
          : "✅ <b>Subscription assigned</b>",
        "",
        `User: <b>${escapeTelegramHtml(userName(user))}</b>`,
        `Telegram ID: <code>${escapeTelegramHtml(user.telegram_id)}</code>`,
        `Plan: <b>${escapeTelegramHtml(planLabel(subscription.plan_id))}</b>`,
        `Starts: ${escapeTelegramHtml(formatDate(subscription.starts_at))}`,
        `Expires: ${escapeTelegramHtml(subscription.expires_at ? formatDate(subscription.expires_at) : "No expiry date")}`,
        `User notification: <b>${userNotified ? "Sent" : "Not delivered"}</b>`,
        "",
        normalizedPlan === "free"
          ? "FREE access is active for 3 days with the 3-videos-per-day quota."
          : "The user should reopen the website or refresh it to load the new subscription.",
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "👤 View user", callback_data: `admin:user:${user.id}` }],
            [{ text: "🏠 Admin", callback_data: "admin:home" }],
          ],
        },
      },
    );
  } catch (error) {
    const message = error?.code === "USER_NOT_FOUND"
      ? "User not found. The user must log in to the website with Telegram at least once before an admin can assign a plan."
      : error?.message || "Unable to change the user plan.";

    await sendTelegramMessage(
      chatId,
      `❌ <b>User plan was not changed</b>\n\n${escapeTelegramHtml(message)}`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🏠 Admin", callback_data: "admin:home" }]],
        },
      },
    );
  }
}

async function revokePlanFromUser(chatId, lookup) {
  if (!lookup) {
    await sendTelegramMessage(chatId, "Usage: <code>/revoke TELEGRAM_ID</code>");
    return;
  }

  try {
    const { revokeAdminSubscription } = await getDatabaseModule();
    const { user, revoked } = await revokeAdminSubscription({ lookup });

    if (revoked.length) {
      try {
        await sendTelegramMessage(
          user.telegram_id,
          [
            "🚫 <b>Your paid TheZiess subscription was removed</b>",
            "",
            "Refresh the website to update your account access.",
          ].join("\n"),
        );
      } catch (notificationError) {
        console.warn("Subscription revoked, but user notification failed:", {
          message: notificationError?.message,
          code: notificationError?.code,
        });
      }
    }

    await sendTelegramMessage(
      chatId,
      [
        revoked.length ? "✅ <b>Paid subscription revoked</b>" : "ℹ️ <b>No active paid subscription</b>",
        "",
        `User: <b>${escapeTelegramHtml(userName(user))}</b>`,
        `Telegram ID: <code>${escapeTelegramHtml(user.telegram_id)}</code>`,
        revoked.length
          ? `Revoked plan: <b>${escapeTelegramHtml(planLabel(revoked[0].plan_id))}</b>`
          : "Nothing was changed.",
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🏠 Admin", callback_data: "admin:home" }]],
        },
      },
    );
  } catch (error) {
    const message = error?.code === "USER_NOT_FOUND"
      ? "User not found."
      : error?.message || "Unable to revoke the subscription.";
    await sendTelegramMessage(
      chatId,
      `❌ <b>Subscription was not revoked</b>\n\n${escapeTelegramHtml(message)}`,
    );
  }
}

async function sendSubscriptions(chatId) {
  const { listAdminActiveSubscriptions } = await getDatabaseModule();
  const subscriptions = await listAdminActiveSubscriptions(15);
  const lines = ["<b>💎 Active Paid Subscriptions</b>", ""];

  if (!subscriptions.length) {
    lines.push("No active paid subscriptions.");
  } else {
    subscriptions.forEach((item, index) => {
      lines.push(
        `${index + 1}. <b>${escapeTelegramHtml(userName(item))}</b> · ${escapeTelegramHtml(planLabel(item.plan_id))}`,
        `   <code>${escapeTelegramHtml(item.telegram_id || item.user_key)}</code> · ${escapeTelegramHtml(remainingLabel(item.expires_at))}`,
      );
    });
  }

  await sendTelegramMessage(chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [[{ text: "🏠 Admin", callback_data: "admin:home" }]],
    },
  });
}

async function sendTrials(chatId) {
  const { listAdminActiveTrials } = await getDatabaseModule();
  const trials = await listAdminActiveTrials(15);
  const lines = ["<b>🆓 Active 3-Day Trials</b>", ""];

  if (!trials.length) {
    lines.push("No active free trials.");
  } else {
    trials.forEach((item, index) => {
      lines.push(
        `${index + 1}. <b>${escapeTelegramHtml(userName(item))}</b>`,
        `   <code>${escapeTelegramHtml(item.telegram_id || item.user_key)}</code> · ${escapeTelegramHtml(remainingLabel(item.expires_at))}`,
      );
    });
  }

  await sendTelegramMessage(chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [[{ text: "🏠 Admin", callback_data: "admin:home" }]],
    },
  });
}

async function sendPayments(chatId) {
  const { listAdminRecentPayments } = await getDatabaseModule();
  const payments = await listAdminRecentPayments(15);
  const lines = ["<b>💳 Recent Payments</b>", ""];

  if (!payments.length) {
    lines.push("No payment records.");
  } else {
    payments.forEach((item, index) => {
      lines.push(
        `${index + 1}. <b>${escapeTelegramHtml(userName(item))}</b> · ${escapeTelegramHtml(planLabel(item.plan_id))}`,
        `   ${formatMoney(item.amount_usd)} · ${escapeTelegramHtml(item.status)} · ${escapeTelegramHtml(formatDate(item.created_at))}`,
      );
    });
  }

  await sendTelegramMessage(chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [[{ text: "🏠 Admin", callback_data: "admin:home" }]],
    },
  });
}

async function handleAdminAction(chatId, action, adminTelegramId) {
  if (action === "admin:home") return sendDashboard(chatId);
  if (action === "admin:stats") {
    return sendTelegramMessage(chatId, await buildStatsMessage(), {
      reply_markup: {
        inline_keyboard: [[{ text: "🏠 Admin", callback_data: "admin:home" }]],
      },
    });
  }
  if (action === "admin:subscriptions") return sendSubscriptions(chatId);
  if (action === "admin:trials") return sendTrials(chatId);
  if (action === "admin:payments") return sendPayments(chatId);
  if (action === "admin:grant:help") return sendGrantHelp(chatId);

  const usersMatch = /^admin:users:(\d+)$/.exec(action);
  if (usersMatch) return sendUsers(chatId, Number(usersMatch[1]));

  const userMatch = /^admin:user:(\d+)$/.exec(action);
  if (userMatch) return sendUserDetails(chatId, userMatch[1]);

  const grantMatch = /^admin:grant:(\d+):(free|pro|premium|max)$/.exec(action);
  if (grantMatch) {
    return grantPlanToUser(
      chatId,
      grantMatch[1],
      grantMatch[2],
      adminTelegramId,
    );
  }

  const revokeMatch = /^admin:revoke:(\d+)$/.exec(action);
  if (revokeMatch) return revokePlanFromUser(chatId, revokeMatch[1]);

  return sendDashboard(chatId);
}

async function sendWelcomeMessage(chat, member) {
  const config = getTelegramWelcomeConfig();
  if (!config.enabled || !isHumanTelegramMember(member)) return;

  const adminMember = await resolveTelegramWelcomeAdmin(chat.id, config);
  const text = buildTelegramWelcomeMessage(member, chat, config, adminMember);
  if (!text) return;

  const replyMarkup = buildTelegramWelcomeKeyboard(config);
  await sendTelegramMessage(chat.id, text, {
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function handleNewChatMembers(message) {
  const chat = message.chat;
  const members = Array.isArray(message.new_chat_members)
    ? message.new_chat_members
    : [];

  if (!chat?.id || members.length === 0) return;

  for (const member of members) {
    await sendWelcomeMessage(chat, member);
  }
}

async function handleTestWelcome(message, senderId) {
  const chat = message.chat;
  if (!chat?.id || !["group", "supergroup"].includes(chat.type)) {
    await sendTelegramMessage(
      chat?.id || senderId,
      "⚠️ <b>/testwelcome must be used inside a Telegram group.</b>",
    );
    return;
  }

  if (!(await isTelegramGroupAdmin(chat.id, senderId))) {
    // Restricted command: silently ignore non-admin users.
    return;
  }

  await sendWelcomeMessage(chat, message.from);
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const senderId = message.from?.id;

  if (Array.isArray(message.new_chat_members)) {
    await handleNewChatMembers(message);
  }

  const text = String(message.text || "").trim();
  if (!chatId || !senderId || !text) return;

  const commandMatch = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text);
  const command = commandMatch?.[1]?.toLowerCase() || "";
  const argument = commandMatch?.[2]?.trim() || "";

  // Ignore unknown commands in Telegram groups. They may belong to another bot.
  const isGroupChat = ["group", "supergroup"].includes(message.chat?.type);
  const knownCommands = new Set([
    "testwelcome", "id", "whoami", "ping", "start", "help", "admin",
    "stats", "users", "user", "grant", "setplan", "addplan", "addsubscription",
    "revoke", "removeplan", "plans", "subscriptions", "trials", "payments",
  ]);

  if (isGroupChat && command && !knownCommands.has(command)) {
    return;
  }

  if (command === "testwelcome") {
    await handleTestWelcome(message, senderId);
    return;
  }

  if (command === "id" || command === "whoami") {
    await sendTelegramMessage(
      chatId,
      [
        "<b>🪪 Your Telegram ID</b>",
        "",
        `<code>${escapeTelegramHtml(senderId)}</code>`,
        "",
        "Add this number to <code>TELEGRAM_ADMIN_IDS</code> in Vercel to enable admin access.",
      ].join("\n"),
    );
    return;
  }

  if (command === "ping") {
    await sendTelegramMessage(
      chatId,
      [
        "✅ <b>TheZiess bot is online</b>",
        "",
        `Your Telegram ID: <code>${escapeTelegramHtml(senderId)}</code>`,
        `Admin access: <b>${isTelegramAdmin(senderId) ? "Enabled" : "Not configured"}</b>`,
      ].join("\n"),
    );
    return;
  }

  if ((command === "start" || command === "help") && !isTelegramAdmin(senderId)) {
    await sendTelegramMessage(
      chatId,
      [
        "<b>👋 TheZiess Method Bot</b>",
        "",
        "The bot connection is working.",
        `Your Telegram ID: <code>${escapeTelegramHtml(senderId)}</code>`,
        "",
        "Add this ID to <code>TELEGRAM_ADMIN_IDS</code>, redeploy, then send <code>/admin</code>.",
      ].join("\n"),
    );
    return;
  }

  if (!isTelegramAdmin(senderId)) {
    // Admin-only commands are intentionally silent for non-admin users.
    // This avoids exposing admin configuration or creating noise in groups.
    return;
  }

  // In groups, normal admin conversation must stay normal conversation.
  // Do not open the admin dashboard just because a configured admin sent text.
  // Admin features are only triggered by explicit bot commands such as /admin.
  if (isGroupChat && !command) {
    return;
  }

  if (command === "start" || command === "help" || command === "admin" || !command) {
    await sendDashboard(chatId);
    return;
  }

  if (command === "stats") {
    await sendTelegramMessage(chatId, await buildStatsMessage());
    return;
  }

  if (command === "users") {
    await sendUsers(chatId, Number(argument) || 1);
    return;
  }

  if (command === "user") {
    if (!argument) {
      await sendTelegramMessage(
        chatId,
        "Usage: <code>/user TELEGRAM_ID</code> or <code>/user @username</code>",
      );
      return;
    }
    await sendUserDetails(chatId, argument);
    return;
  }

  if (command === "grant" || command === "setplan" || command === "addplan" || command === "addsubscription") {
    const [lookup, planId] = argument.split(/\s+/).filter(Boolean);
    await grantPlanToUser(chatId, lookup, planId, senderId);
    return;
  }

  if (command === "revoke" || command === "removeplan") {
    const [lookup] = argument.split(/\s+/).filter(Boolean);
    await revokePlanFromUser(chatId, lookup);
    return;
  }

  if (command === "plans") {
    await sendGrantHelp(chatId);
    return;
  }

  if (command === "subscriptions") {
    await sendSubscriptions(chatId);
    return;
  }

  if (command === "trials") {
    await sendTrials(chatId);
    return;
  }

  if (command === "payments") {
    await sendPayments(chatId);
    return;
  }

  await sendTelegramMessage(
    chatId,
    "Unknown command. Use <code>/admin</code> to open the admin dashboard.",
  );
}

async function handleCallback(callbackQuery) {
  const senderId = callbackQuery.from?.id;
  const chatId = callbackQuery.message?.chat?.id;
  const action = String(callbackQuery.data || "");

  if (!senderId || !chatId) return;

  if (!isTelegramAdmin(senderId)) {
    // Stop the Telegram loading spinner without showing an access message.
    await answerTelegramCallback(callbackQuery.id);
    return;
  }

  await answerTelegramCallback(callbackQuery.id);
  await handleAdminAction(chatId, action, senderId);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "TheZiess Telegram webhook",
      message: "Webhook endpoint is online. Use /api/telegram/health for connection status.",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");
  let update = {};

  try {
    const receivedSecret = getHeaderValue(
      req,
      "x-telegram-bot-api-secret-token",
    );

    if (!safeEqual(receivedSecret, getTelegramWebhookSecret())) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }

    update = readBody(req);

    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", {
      message: error?.message,
      code: error?.code,
      stack: error?.stack,
    });

    const chatId =
      update.message?.chat?.id ||
      update.callback_query?.message?.chat?.id ||
      null;

    if (chatId) {
      try {
        await sendTelegramMessage(
          chatId,
          [
            "⚠️ <b>Bot backend error</b>",
            "",
            escapeTelegramHtml(error?.message || "Unknown server error"),
            "",
            "Open <code>/api/telegram/health</code> on your website to check the configuration.",
          ].join("\n"),
        );
      } catch (notificationError) {
        console.error("Unable to send Telegram error notification:", notificationError);
      }
    }

    // Return 200 after logging so Telegram does not repeatedly deliver a bad update.
    return res.status(200).json({ ok: false });
  }
}
