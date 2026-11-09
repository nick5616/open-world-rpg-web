# CR 018: opt-in PvP and party duels (playtest 2)

Nicole, playtest 2: "Add pvp option if not in the same party and duels if you are which are a facilitated means". Spec section 2 said "No PvP of any kind, no duels, no kill feeds"; this CR amends it (docs/SPEC.md section 2 notes the change). Players still cannot hurt each other unless both opt in, or agree to a duel.

## Rules

| | Open PvP | Duel |
| --- | --- | --- |
| Who | Two players who are both flagged and not in the same party | Two members of the same party, after a challenge and an accept |
| Where | Anywhere except safe zones: every settlement out to its radius + `pvp.settlementMarginM` (20 m), and the Haven (the areas within `difficulty.havenRadiusM` of the world spawn, the same cells Event 901 flags as the Haven) | Anywhere (towns and the Haven included: it is consensual and the ring keeps it in place) |
| Damage | The same hit against a physical enemy (level, skill, gear, crit, passives) x `pvp.damageMult` (0.5), then the victim's armor and shield. No statuses, skill XP, kill XP or loot from players | Same |
| End | The victim goes down (the usual respawn; nothing is dropped) and both get the kill feed | At 1 health (a duel hit never downs), leaving the ring > 5 s, yielding, logging out / leaving the zone (the other wins), 3 minutes (draw), an enemy downing a duelist (called off) |
| After | - | Both get back the health the duel took (enemy damage during the duel stays) and the mana they had at the accept; the result goes to both and to party chat |

Enemies attacking during a duel hurt both normally. Duelists are not shielded from outsiders: a flagged outsider may still fight a flagged duelist under the open-PvP rules.

Flag timers (anti-abuse): on is immediate; off takes `pvp.flagOffDelayS` (10 s) and any PvP hit given or taken meanwhile restarts the wait (no flagging off to escape a fight); requests are `pvp.toggleCooldownS` (5 s) apart; no request within `pvp.combatLockS` (6 s) of dealing or taking any damage. The flag is per session (a fresh login starts unflagged) and crosses zone borders (WP16 handoff field `pvp`); duels do not cross borders (leaving the zone loses the duel).

Duel numbers: challenge within 30 m, 20 s to answer, 3-2-1 countdown, a 25 m ring around the midpoint of the two at the accept, 5 s outside the ring forfeits, 180 s cap.

## Contract

- `contracts/combat.yaml` v4: a `pvp` block (the numbers above; generated into `COMBAT.pvp` and `combatdefs.D.PvP`).
- `contracts/events.md`: Interact targetKind 70 `pvp` (1 flag, 2 challenge, 3 answer, 4 yield); Events 990-997 (`pvp_state`, `pvp_refused`, `pvp_hit`, `pvp_kill`, `duel_challenge`, `duel_state`, `duel_ended`, `duel_outside`; 990-999 registered, 998-999 reserved); HitResult refusal codes 16 (safe zone) and 17 (same party), code 1 now also "a player you may not fight"; player typeId bit 12 = flagged, bit 13 = dueling (bits 0-11 stay the weapon look).
- `contracts/protocol.yaml`: HitClaim's doc only (no wire change, protocol version stays 5, golden vectors unchanged).

## Wire cost

No new snapshot field: the flag and "dueling" ride two spare bits of the player's existing typeId, which changes only on a toggle and rides the usual delta coding, ghosts and handoffs. Everything else is reliable Events to the players involved (a flag toggle, a hit, a challenge). A player who never flags, duels or attacks a player is sent nothing new, so the G5 scale scenario (bots) is byte-identical (`LODESTONE_WIRE_DIGEST=1 go test ./server/zone/internal/game -run WireDigest` unchanged).

## Consumers

- Zone: `server/zone/internal/combat/pvp.go` (`World.ClaimPlayer`: the PvE validation against the victim's position history, `hurtByPlayer`; `hurtPlayer`'s armor/shield/down steps split into `mitigate`/`downPlayer` and shared), `server/zone/internal/game/pvp.go` (flag, timers, safe zones, rules, kill feed), `duel.go` (lifecycle), `server/zone/pvp.go` (party chat through the social bus).
- Client: `client/src/ui/pvp` (store, Events, Interacts, HUD: flag indicator, challenge prompt, countdown, ring, result banner, kill feed), the combat runtime's hit targets (hostile players next to enemies), nameplates (red crossed swords), the character panel (PvP toggle), chat commands `/pvp` and `/duel`, the party frame (Duel button), audio trigger mappings.
- Tests: `server/zone/internal/combat/pvp_test.go`, `server/zone/internal/game/pvp_test.go`, `client/src/ui/pvp/pvp.test.ts`.

## Not covered

- PvP across a zone border (the victim on another zone is a ghost there; claims on it are refused as unknown targets). Duels end when a duelist changes zone.
- Lag compensation stays the lenient PvE window (spec 9): a fast-strafing player can be hit a little behind where they are, by design.
- Duel results reach party members hosted by the duelists' zone (the usual case); members on other zones do not get the party chat line.
