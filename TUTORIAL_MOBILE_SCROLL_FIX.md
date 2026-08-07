# Tutorial Mobile Scroll Fix

Fixed the Tutorial page so it can be vertically scrolled on phones and tablets.

## Root cause
The global `.modal-overlay.active` rule used `touch-action: none`, which disabled touch panning for every modal, including the full-page Tutorial modal.

## Changes
- Restored `touch-action: pan-y` for the Tutorial overlay only.
- Kept vertical overflow enabled and added iOS momentum scrolling.
- Added dynamic viewport height support (`100dvh`).
- Preserved bottom safe-area spacing on mobile.
- Bumped the stylesheet cache query in `index.html` so deployed browsers receive the fix immediately.

No Telegram, subscription, video patch, API, database, or TikTok logic was changed.
