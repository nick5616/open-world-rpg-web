# 0008: Social service (WP08)

Date: 2026-11-08

## Every delivery goes through Redis pub/sub, even local ones

Each event (a chat line, a party frame, a kick) is published to
`social:{worldId}` and routed by every process to its own sessions; the
sender's process does not short-cut local recipients. One path means a
whisper between players on two processes, or presenting two zones, behaves
exactly like one between neighbours, and the two-process integration test
exercises the production path. Cost: one Redis round trip per event
(sub-millisecond locally), at chat volume. Routing decisions (region,
30 m radius, mutes, profanity filter) are made by the receiving process
against its own sessions' state, so the sender never needs to know where
anyone is.

## Relations by character id

See CR 001. 0001's account-keyed `friends`/`blocks` cannot hold local
profiles; character ids can, survive the local → account upgrade, and match
how players address each other (character names, per world).

## Positions for local chat come from the client (for now)

Local chat (30 m) and zone chat route on the position and region in the
client's `presence` frames. That is not authoritative: a modified client can
claim to stand anywhere and read local chat there. Acceptable for v1 (local
chat is public speech), and spec 11's `worldpos:{worldId}` (zone-written
positions at 1 Hz) is the fix: once a zone writes it, the social service
should prefer it over presence. Recorded in STATUS.

## Blocked whispers look delivered, and are not stored

A whisper to someone who blocked you returns your own echo and
`whisper_status delivered`, and nothing else happens. Storing it in the
conversation would surface it if the target later unblocked. Same rule for
party invites and friend requests to someone who blocked you ("sent").
Blocking also ends any friendship or pending request in the same
transaction.

## Local profiles read global chat but can't send

Spec 10/11 say local profiles "can't use global chat" next to "hear voice
but not transmit". We read that as listen-only, like voice. Spec 10's
whisper rule is applied to the sender only (local profiles whisper friends
and party); whispers to local profiles from anyone are allowed, since the
target can block.

## Profanity filter on delivery, word based

Stored text is raw so reports show moderators what was written; each
recipient gets the filtered or raw text per their own setting. Matching is
on whole words after case and leet folding, with explicit prefix and
anywhere entries, and an allow-list (the game's own "Bitchin'" rarity tier,
"assassin", "Scunthorpe"), because substring filters mask innocent words.

## Limits and their errors

Per-channel token buckets (the-circle `consumers.py` Bucket via
`server/pkg/ratelimit`): one bucket per channel so a party burst never
starves whispers; global slow mode is a bucket of 1 refilling every 10 s. A
first gate limits every inbound frame (30 burst, 15/s). Refusal errors are
sent at most once per second per code: a flooding client must not turn into
a flood of replies. Flood result: `docs/evidence/wp08-flood.txt`.

## Parties

Party ids are reserved at invite time; the party exists from the first
acceptance, led by the inviter. Invites sent before anyone accepted carry
different reserved ids, so a later acceptance joins the inviter's current
party when the reserved one never formed. A leaving leader passes to the
first online member; a party of one disbands. Offline members stay for
`PARTY_RECONNECT_GRACE_S` (zset `partygrace:{worldId}` of deadlines; the
reaper removes them). All changes are WATCH/MULTI transactions with retry
(the-circle `claim_seat` loop).

## Presence and reaping

`presence:{charId}` (TTL 30 s) is refreshed by the server every 10 s for
every live socket; WebSocket pings every 20 s detect dead sockets (3d
portfolio `server.mjs` pattern). `online:{worldId}` lists who should be
online; the reaper (every process, every 10 s) runs the offline path for
entries whose presence expired, i.e. sessions of a crashed process
(the-circle `reap_dead`). A compare-and-delete Lua script makes sure a late
cleanup never removes a newer session's entry.

## Moderation targets owners, not characters

Admin actions resolve a character name to its account (accounts.status,
also enforced by the director) or local profile (`social_sanctions`), apply
to all its characters in all worlds, are logged in `moderation_log`, and
reach live sessions immediately via the bus.
