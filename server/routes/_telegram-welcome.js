import {
  escapeTelegramHtml,
  telegramApi,
} from "./_telegram-bot.js";

function environment(name, fallback = "") {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
}

function environmentBoolean(name, fallback = false) {
  const value = environment(name).toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off", "disabled"].includes(value);
}

function normalizeLanguage(value) {
  const language = String(value || "").trim().toLowerCase();
  if (["km", "kh", "khmer"].includes(language)) return "km";
  if (["en", "english"].includes(language)) return "en";
  return "both";
}

export function getTelegramWelcomeConfig() {
  return {
    enabled: environmentBoolean("TELEGRAM_WELCOME_ENABLED", true),
    language: normalizeLanguage(
      environment("TELEGRAM_WELCOME_LANGUAGE", "km"),
    ),
    khmerTemplate: environment(
      "TELEGRAM_WELCOME_KHMER_TEMPLATE",
      "សូមស្វាគមន៍ {mention} មកកាន់ក្រុម <b>{group}</b>",
    ),
    englishTemplate: environment(
      "TELEGRAM_WELCOME_ENGLISH_TEMPLATE",
      "Welcome {mention} to <b>{group}</b> 🎉",
    ),
    rulesUrl: environment("TELEGRAM_WELCOME_RULES_URL"),
    websiteUrl: environment("TELEGRAM_WELCOME_WEBSITE_URL"),
    rulesLabel: environment("TELEGRAM_WELCOME_RULES_LABEL", "📜 Rules"),
    websiteLabel: environment(
      "TELEGRAM_WELCOME_WEBSITE_LABEL",
      "🌐 Website",
    ),
    adminUsername: environment("TELEGRAM_WELCOME_ADMIN_USERNAME", "thephal")
      .replace(/^@/, "")
      .toLowerCase(),
    adminContactTemplate: environment(
      "TELEGRAM_WELCOME_ADMIN_CONTACT_TEMPLATE",
      "ទំនាក់ទំនងទៅកាន់Admin: {adminMention}",
    ),
  };
}

export function telegramMemberDisplayName(member) {
  const name = [member?.first_name, member?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || member?.username || "Telegram member";
}

export function telegramMemberMention(member) {
  const name = escapeTelegramHtml(telegramMemberDisplayName(member));
  const id = String(member?.id || "").trim();
  return id ? `<a href="tg://user?id=${escapeTelegramHtml(id)}">${name}</a>` : name;
}

function applyWelcomeTemplate(template, values) {
  return String(template || "")
    .replaceAll("{mention}", values.mention)
    .replaceAll("{name}", values.name)
    .replaceAll("{group}", values.group)
    .replaceAll("{adminMention}", values.adminMention);
}

export function buildTelegramWelcomeMessage(
  member,
  chat,
  config = getTelegramWelcomeConfig(),
  adminMember = null,
) {
  const adminUsername = String(config.adminUsername || "thephal")
    .replace(/^@/, "")
    .trim();

  const adminMention = adminMember
    ? telegramMemberMention(adminMember)
    : `<a href="https://t.me/${escapeTelegramHtml(adminUsername)}">Admin</a>`;

  const values = {
    mention: telegramMemberMention(member),
    name: escapeTelegramHtml(telegramMemberDisplayName(member)),
    group: escapeTelegramHtml(chat?.title || "this group"),
    adminMention,
  };

  const messages = [];
  if (config.language === "km" || config.language === "both") {
    messages.push(applyWelcomeTemplate(config.khmerTemplate, values));
  }
  if (config.language === "en" || config.language === "both") {
    messages.push(applyWelcomeTemplate(config.englishTemplate, values));
  }

  if (config.adminContactTemplate) {
    messages.push(applyWelcomeTemplate(config.adminContactTemplate, values));
  }

  return messages.filter(Boolean).join("\n");
}

export async function resolveTelegramWelcomeAdmin(
  chatId,
  config = getTelegramWelcomeConfig(),
) {
  const targetUsername = String(config.adminUsername || "thephal")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();

  if (!chatId || !targetUsername) return null;

  try {
    const administrators = await telegramApi("getChatAdministrators", {
      chat_id: String(chatId),
    });

    if (!Array.isArray(administrators)) return null;

    const match = administrators.find((entry) => {
      const username = String(entry?.user?.username || "").trim().toLowerCase();
      return username === targetUsername;
    });

    return match?.user || null;
  } catch {
    // Welcome messages must still work if Telegram cannot resolve the admin.
    return null;
  }
}

export function buildTelegramWelcomeKeyboard(
  config = getTelegramWelcomeConfig(),
) {
  const buttons = [];

  if (config.rulesUrl) {
    buttons.push({ text: config.rulesLabel, url: config.rulesUrl });
  }
  if (config.websiteUrl) {
    buttons.push({ text: config.websiteLabel, url: config.websiteUrl });
  }

  return buttons.length > 0 ? { inline_keyboard: [buttons] } : undefined;
}

export function isHumanTelegramMember(member) {
  return Boolean(member?.id) && member?.is_bot !== true;
}

export async function isTelegramGroupAdmin(chatId, userId) {
  const member = await telegramApi("getChatMember", {
    chat_id: String(chatId),
    user_id: String(userId),
  });

  return member?.status === "administrator" || member?.status === "creator";
}
