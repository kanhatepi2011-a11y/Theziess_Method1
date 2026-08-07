# Automatic Telegram login screen

Updated behavior:

- New visitors who have no Telegram session automatically see the Telegram login modal after the session check completes.
- Returning users with a valid Telegram server session do not see the login modal.
- If the server session is temporarily unavailable, the existing saved Telegram fallback is still respected.
- Logging out immediately opens the Telegram login modal again.
- Telegram OIDC/API/authentication logic was not replaced.
