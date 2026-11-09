# 0005: Dense crowds and the downlink budget

Date: 2026-11-08 · Decided by: orchestrator (Opus), pending Nicole's review

## Problem

WP03 measured ~530 kbps downlink per client when 143 players stand within 64 m
of each other, because the ring table (spec 9) sends the whole near ring at
30 Hz. The spec budget is 160 kbps "with 100 players in view"; clustered soaks
where players are spread across rings met it (131 kbps), the everyone-on-one-spot
case does not.

## Decision

Keep the ring table as the *maximum* rate and add a per-client byte budget on
top of it: each tick the snapshot builder spends at most budget/30 bytes, filling
entities in priority order (party members, then by distance, with an age bonus so
starved far entities still get a turn). Entities that don't fit wait for the next
tick and are sent with the accumulated delta, so nothing is lost, only rate is
reduced. Interpolation already tolerates irregular sample spacing (wizard-wars
EntityInterpolation adapts its delay to arrival jitter).

This does not change the meaning of the ring table, only adds a ceiling, so it
needs no contract change. Default budget: 150 kbps (inside the 160 kbps budget
with headroom for reliable traffic). Owner: WP06 (snapshot handling), verified
in WP19 soak scenario 1.

## Amendment (WP19 second pass, 2026-11-09): reliable traffic counts

WP19's scenario 1 (300 players, 2,000 awake enemies) measured 158-159 kbps
per client against the 160 kbps budget: the 150 kbps snapshot budget held,
but combat telegraphs, projectiles, hit and damage events (reliable, on top)
added up to ~9 kbps in a big fight. "Headroom for reliable traffic" was not
enough once WP13 combat existed.

Decision: the per-client budget covers everything the zone sends, not just
snapshots. The transport counts reliable bytes (with framing) when they are
queued (`transport.Stats.ReliableQueued`); before each snapshot the zone
charges what was queued since the previous one to the same token bucket
(`snapshot.Encoder.Charge`), so the next snapshots carry that many fewer
entity bytes. The debt is capped at one burst (3 ticks of allowance): a
one-off large reliable message (an inventory on join) costs a few ticks of
entity updates, not seconds of them, and in that case the client may be
briefly above 150 kbps, never above the burst. The 150 kbps default stays,
now as the total; 10 kbps of the 160 kbps budget remain for framing
estimates and clock pongs.

Measured after (scenario 1, clean): downlink max 148-151 kbps (was 158-159);
thailand: see `docs/decisions/v1-capacity.md`. Metric
`zone_budget_reliable_charged_bytes_total`. Reliable messages are never
delayed or dropped by this: only snapshot entity records yield.
