import { describe, expect, it } from "vitest";

import {
  buildTelegramWelcomeKeyboard,
  buildTelegramWelcomeMessage,
  isHumanTelegramMember,
  telegramMemberMention,
} from "../server/routes/_telegram-welcome.js";

const member = {
  id: 123456,
  first_name: "Sok",
  last_name: "Phal",
  username: "thephal",
  is_bot: false,
};

const chat = { id: -100123, title: "TheZiess Community", type: "supergroup" };

const config = {
  enabled: true,
  language: "both",
  khmerTemplate: "សូមស្វាគមន៍ {mention} មកកាន់ <b>{group}</b>",
  englishTemplate: "Welcome {mention} to <b>{group}</b>",
  rulesUrl: "https://example.com/rules",
  websiteUrl: "https://example.com",
  rulesLabel: "Rules",
  websiteLabel: "Website",
  adminUsername: "thephal",
  adminContactTemplate: "ទំនាក់ទំនងទៅកាន់Admin: {adminMention}",
};

describe("Telegram welcome system", () => {
  it("mentions the human member and includes the group name in both languages", () => {
    const admin = {
      id: 999999,
      first_name: "Sokphal",
      username: "thephal",
      is_bot: false,
    };
    const message = buildTelegramWelcomeMessage(member, chat, config, admin);

    expect(message).toContain('tg://user?id=123456');
    expect(message).toContain("Sok Phal");
    expect(message).toContain("TheZiess Community");
    expect(message).toContain("សូមស្វាគមន៍");
    expect(message).toContain("Welcome");
    expect(message).toContain("ទំនាក់ទំនងទៅកាន់Admin:");
    expect(message).toContain('tg://user?id=999999');
    expect(message).toContain("Sokphal");
    expect(message).not.toContain("@thephal");
  });

  it("escapes member names safely", () => {
    expect(telegramMemberMention({ ...member, first_name: "<Sok>" })).toContain(
      "&lt;Sok&gt;",
    );
  });

  it("creates optional Rules and Website buttons", () => {
    expect(buildTelegramWelcomeKeyboard(config)).toEqual({
      inline_keyboard: [
        [
          { text: "Rules", url: "https://example.com/rules" },
          { text: "Website", url: "https://example.com" },
        ],
      ],
    });
  });

  it("does not classify bot accounts as welcome targets", () => {
    expect(isHumanTelegramMember(member)).toBe(true);
    expect(isHumanTelegramMember({ ...member, is_bot: true })).toBe(false);
  });
});
