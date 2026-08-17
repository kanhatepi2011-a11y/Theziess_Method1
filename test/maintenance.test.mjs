import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    getMaintenanceState: vi.fn(),
    setMaintenanceState: vi.fn(),
}));

const telegram = vi.hoisted(() => ({
    sendTelegramMessage: vi.fn(),
}));

vi.mock("../server/routes/_db.js", () => ({
    DEFAULT_MAINTENANCE_MESSAGE:
        "We are improving TheZiess Method. Please check back shortly.",
    getMaintenanceState: db.getMaintenanceState,
    setMaintenanceState: db.setMaintenanceState,
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

import maintenanceStatus from "../server/routes/maintenance/status.js";
import telegramWebhook from "../server/routes/telegram/webhook.js";

function createResponse() {
    return {
        headers: {},
        statusCode: 200,
        payload: null,
        setHeader(name, value) {
            this.headers[name] = value;
        },
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

describe("admin-controlled website maintenance", () => {
    beforeEach(() => {
        db.getMaintenanceState.mockReset();
        db.setMaintenanceState.mockReset();
        telegram.sendTelegramMessage.mockReset();
    });

    it("lets the existing website Telegram admin bot enable maintenance", async () => {
        const maintenance = {
            enabled: true,
            message: "Scheduled upgrade",
            updatedBy: "telegram:123",
            updatedAt: "2026-08-17T00:00:00.000Z",
        };
        db.getMaintenanceState.mockResolvedValue({
            enabled: false,
            message: "Previous maintenance message",
            updatedBy: null,
            updatedAt: null,
        });
        db.setMaintenanceState.mockResolvedValue(maintenance);
        const response = createResponse();

        await telegramWebhook(
            {
                method: "POST",
                headers: {
                    "x-telegram-bot-api-secret-token": "website-webhook-secret",
                },
                body: {
                    message: {
                        chat: { id: 456, type: "private" },
                        from: { id: 123 },
                        text: "/maintenance on Scheduled upgrade",
                    },
                },
            },
            response,
        );

        expect(response.statusCode).toBe(200);
        expect(response.payload).toEqual({ ok: true });
        expect(db.setMaintenanceState).toHaveBeenCalledWith({
            enabled: true,
            message: "Scheduled upgrade",
            updatedBy: "telegram:123",
        });
        expect(telegram.sendTelegramMessage).toHaveBeenCalledWith(
            456,
            expect.stringContaining("Maintenance mode enabled"),
            expect.any(Object),
        );
    });

    it("silently rejects maintenance commands from non-admin Telegram users", async () => {
        const response = createResponse();

        await telegramWebhook(
            {
                method: "POST",
                headers: {
                    "x-telegram-bot-api-secret-token": "website-webhook-secret",
                },
                body: {
                    message: {
                        chat: { id: 456, type: "private" },
                        from: { id: 999 },
                        text: "/maintenance on",
                    },
                },
            },
            response,
        );

        expect(response.statusCode).toBe(200);
        expect(db.setMaintenanceState).not.toHaveBeenCalled();
        expect(telegram.sendTelegramMessage).not.toHaveBeenCalled();
    });

    it("lets an admin disable maintenance without replacing the saved message", async () => {
        const current = {
            enabled: true,
            message: "Scheduled upgrade",
            updatedBy: "telegram:123",
            updatedAt: "2026-08-17T00:00:00.000Z",
        };
        db.getMaintenanceState.mockResolvedValue(current);
        db.setMaintenanceState.mockResolvedValue({
            ...current,
            enabled: false,
        });
        const response = createResponse();

        await telegramWebhook(
            {
                method: "POST",
                headers: {
                    "x-telegram-bot-api-secret-token": "website-webhook-secret",
                },
                body: {
                    message: {
                        chat: { id: 456, type: "private" },
                        from: { id: 123 },
                        text: "/maintenance off",
                    },
                },
            },
            response,
        );

        expect(db.setMaintenanceState).toHaveBeenCalledWith({
            enabled: false,
            message: "Scheduled upgrade",
            updatedBy: "telegram:123",
        });
        expect(telegram.sendTelegramMessage).toHaveBeenCalledWith(
            456,
            expect.stringContaining("Maintenance mode disabled"),
            expect.any(Object),
        );
    });

    it("fails open when the public status database check is unavailable", async () => {
        db.getMaintenanceState.mockRejectedValue(
            new Error("database unavailable"),
        );
        const response = createResponse();

        await maintenanceStatus({ method: "GET" }, response);

        expect(response.statusCode).toBe(200);
        expect(response.payload.ok).toBe(true);
        expect(response.payload.degraded).toBe(true);
        expect(response.payload.maintenance.enabled).toBe(false);
    });
});
