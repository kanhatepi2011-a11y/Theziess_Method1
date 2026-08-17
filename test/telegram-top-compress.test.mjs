import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
    listAdminTopCompressors: vi.fn(),
}));

const telegram = vi.hoisted(() => ({
    sendTelegramMessage: vi.fn(),
}));

vi.mock("../server/routes/_db.js", () => ({
    listAdminTopCompressors: database.listAdminTopCompressors,
}));

vi.mock("../server/routes/_telegram-bot.js", () => ({
    answerTelegramCallback: vi.fn(),
    escapeTelegramHtml: (value) =>
        String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;"),
    getTelegramWebhookSecret: () => "website-webhook-secret",
    isTelegramAdmin: (userId) => String(userId) === "123",
    safeEqual: (left, right) => left === right,
    sendTelegramMessage: telegram.sendTelegramMessage,
}));

import telegramWebhook from "../server/routes/telegram/webhook.js";

function createResponse() {
    return {
        statusCode: 200,
        payload: null,
        setHeader() {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        },
    };
}

function commandRequest(text, senderId = 123) {
    return {
        method: "POST",
        headers: {
            "x-telegram-bot-api-secret-token": "website-webhook-secret",
        },
        body: {
            message: {
                chat: { id: 456, type: "private" },
                from: { id: senderId },
                text,
            },
        },
    };
}

describe("existing website Telegram bot top compress command", () => {
    beforeEach(() => {
        database.listAdminTopCompressors.mockReset();
        telegram.sendTelegramMessage.mockReset();
    });

    it("shows the real seven-day compression leaderboard to an admin", async () => {
        database.listAdminTopCompressors.mockResolvedValue([
            {
                user_key: "9",
                telegram_id: "123",
                username: "thephal",
                first_name: "Sok",
                last_name: "Phal",
                total_compressions: 12,
                total_input_bytes: String(1024 ** 3),
                total_output_bytes: String(512 * 1024 ** 2),
                last_compression_at: "2026-08-17T00:00:00.000Z",
            },
        ]);
        const response = createResponse();

        await telegramWebhook(commandRequest("/topcompress 7d"), response);

        expect(response.payload).toEqual({ ok: true });
        expect(database.listAdminTopCompressors).toHaveBeenCalledWith({
            period: "7d",
            limit: 10,
        });
        expect(telegram.sendTelegramMessage).toHaveBeenCalledWith(
            456,
            expect.stringContaining("Top Compress Users"),
            expect.objectContaining({ reply_markup: expect.any(Object) }),
        );
        expect(telegram.sendTelegramMessage.mock.calls[0][1]).toContain("12");
        expect(telegram.sendTelegramMessage.mock.calls[0][1]).toContain(
            "@thephal",
        );
    });

    it("does not expose the leaderboard to a non-admin", async () => {
        const response = createResponse();

        await telegramWebhook(
            commandRequest("/topcompress all", 999),
            response,
        );

        expect(response.payload).toEqual({ ok: true });
        expect(database.listAdminTopCompressors).not.toHaveBeenCalled();
        expect(telegram.sendTelegramMessage).not.toHaveBeenCalled();
    });
});
