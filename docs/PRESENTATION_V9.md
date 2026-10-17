# My Store V9 — live welcome, animated emoji, customer inbox, on-demand chat cleanup

## What V9 changes

- Home inline keyboard is intentionally unchanged. The greeting is a customizable `home_template` with live placeholders: `{store}`, `{name}`, `{id}`, `{users}`, `{balance_iqd}`, `{balance_usd}`, and optional `{instructions}`. The default template matches the new Arabic reference. IQD is the ledger's canonical currency; USD is display-only using the **owner-configured** USD/IQD rate; no rate means `غير محدد` rather than a made-up value.
- Admin `/admin` → `🎨 تخصيص واجهة المتجر` → edit home template, preview current values, and configure **custom emoji IDs** for the home, shop, profile, wallet, orders and support headings. Send a `custom_emoji_id` or a Telegram message containing a custom emoji; the bot extracts the entity. Plain Unicode emoji remains the fallback when no ID is configured or the API refuses the custom entity. Telegram decides whether the client animates it; no separate GIF/sticker is substituted.
- Customer `📦 طلباتي` → `📨 رسائلي — ردود الدعم` → inbox → chronological/paginated text messages and media attachments with Baghdad-local timestamps. Media buttons use the authenticated user's ID in DB queries so cross-user retrieval is blocked. Replies already delivered by the V8 owner support inbox remain available. If a moderator deliberately deletes the local thread, the removed items won't appear in either inbox.
- **Only** pressing a Home callback, `/menu`, or `/start` requests cleanup of previously tracked chat messages, after which a fresh main-menu message is sent. Other buttons do not trigger deletion. Telegram may reject deletion due to its deletion window, permissions, or previously untracked messages. The bot does not pretend all historical messages were deleted. D1 financial data, wallet ledger, orders, and support history remain intact. Media file IDs remain in D1; availability of files is ultimately subject to Telegram.

## D1 migration

`0008_custom_ui_customer_inbox_cleanup.sql` adds only `chat_cleanup_messages` (message IDs, direction, timestamp) plus an index. Do not roll back the migration by deleting production tables or customer records.

## UI scope / limits

- Custom emoji animation may not be available for all bot accounts, Telegram client versions or placements; Bot API support is the source of truth. In unsupported cases, Unicode emoji are displayed. Inline button colors are based on Telegram-supported styles; no claims about pixel-perfect rendering.
- The bot records new message IDs after this release. It **cannot** discover message IDs of the old historical conversation.
- Cleanup is explicitly user-initiated by opening Home, and limited to recent messages (47 hours) and up to 80 tracked IDs per request. It does not touch the backend ledger or change paid order status.
- The legacy `welcome_text` remains accessible for compatibility with prior integrations, but the main menu now uses `home_template`.
- Admin role checks remain guarded by the original `ADMIN_ID` secret; setting a new template or emoji does not grant access to customers.

## Test and release

Run `npm test`; deploy through the existing GitHub Actions workflow only after reviewing the successful test run. Verify `/start`, admin visual customization, `/orders` → `رسائلي`, image/video reply playback, and home cleanup on Telegram mobile; actual Telegram deletion/animation behaviors require real-client validation.
