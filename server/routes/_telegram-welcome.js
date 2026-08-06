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
      environment("TELEGRAM_WELCOME_LANGUAGE", "both"),
    ),
    khmerTemplate: environment(
      "TELEGRAM_WELCOME_KHMER_TEMPLATE",
      "សូមស្វាគមន៍ {mention} មកកាន់ក្រុម <b>{group}</b> 🎉",
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
    .replaceAll("{group}", values.group);
}

export function buildTelegramWelcomeMessage(
  member,
  chat,
  config = getTelegramWelcomeConfig(),
) {
  const values = {
    mention: telegramMemberMention(member),
    name: escapeTelegramHtml(telegramMemberDisplayName(member)),
    group: escapeTelegramHtml(chat?.title || "this group"),
  };

  const messages = [];
  if (config.language === "km" || config.language === "both") {
    messages.push(applyWelcomeTemplate(config.khmerTemplate, values));
  }
  if (config.language === "en" || config.language === "both") {
    messages.push(applyWelcomeTemplate(config.englishTemplate, values));
  }

  return messages.filter(Boolean).join("\n\n");
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
