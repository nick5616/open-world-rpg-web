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
