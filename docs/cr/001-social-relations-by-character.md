# CR 001: Social relations keyed by character id (migration 0003)

Author: WP08 · Date: 2026-11-08 · Status: applied on `wp/08-social`

## What

New migration `contracts/migrations/0003_social.sql` (additive only):

- `social_friends (requester, target, world_id, state)`: friend requests and friendships between **characters**.
- `social_blocks (blocker, blocked)`, `social_mutes (muter, muted)`: by character.
- `social_settings (character_id, profanity_filter)`: per-character preferences (missing row = filter on).
- `social_sanctions (profile_id, status, reason)`: mute/suspend/ban for local profiles, which have no `accounts.status`.
- `moderation_log`: every admin CLI action.
- `reports` gains `world_id`, `reporter_name`, `reported_name`, `reason` (nullable); `reporter`/`reported` (no FK since 0001) now hold character ids. Index on open reports.

## Why

0001's `friends`/`blocks` reference `accounts(id)`, but spec 11 gives local-profile players (no account row) friends, blocks and mutes, and spec 10 needs them for the local-profile whisper rule ("friends and party only"). Character ids are the identity both kinds share (`characters` and `local_characters` are both uuid keyed, and WP04's upgrade keeps the id), players address each other by character name, and characters are per world, so relations are naturally per world. No foreign keys on character columns: an id may live in either table (and moves on upgrade), and test bots carry ticket-only characters.

Accounts keep `accounts.status` for moderation (the director already enforces suspended/banned at connect); local profiles get `social_sanctions` instead of a new column on WP04's `local_profiles`.

## Consumers affected

| Consumer | Change |
| --- | --- |
| `server/social` (WP08) | Uses the new tables (this CR's only reader/writer) |
| `server/pkg/migrate` | None: picks up the file; `TestLoadOrdersRealMigrations` still passes |
| `server/account`, `server/director` (WP04) | None. Integration tests migrate scratch DBs with 0003 included |
| 0001 `friends`, `blocks` | Left in place, unused (additive rule). A later cleanup migration may drop them |

Shared dev database: `npm run migrate` applies 0003. It only creates tables and adds nullable columns.
