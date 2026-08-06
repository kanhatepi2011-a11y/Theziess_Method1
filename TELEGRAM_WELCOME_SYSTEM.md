# Telegram Welcome System

This project now handles Telegram group welcome messages through the existing
`/api/telegram/webhook` endpoint and existing Telegram bot token.

## Features

- Welcomes each new human group member once per Telegram join update.
- Mentions the member by display name.
- Includes the Telegram group name.
- Supports Khmer, English, or both languages.
- Supports optional Rules and Website inline buttons.
- Ignores bot accounts.
- Adds `/testwelcome` for Telegram group administrators.

## Required deployment steps

1. Configure the `TELEGRAM_WELCOME_*` environment variables shown in
   `.env.example`.
2. Add the existing bot to the Telegram group.
3. Allow the bot to send messages in the group.
4. Redeploy the website.
5. Open `/api/telegram/setup?force=1` using the configured setup key when
   required, so Telegram refreshes the existing webhook and command list.
6. Run `/testwelcome` in the group from a group administrator account.
