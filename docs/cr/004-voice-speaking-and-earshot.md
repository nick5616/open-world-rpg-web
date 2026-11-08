# CR 004: Speaking input flag and the earshot message

Author: WP11 · Date: 2026-11-08 · Status: applied on `wp/11-voice`

## What

1. **`contracts/protocol.yaml` version 1 → 2 (additive):** `InputFlag` gains `speaking: 15`. The client sets it on every input frame while it is transmitting voice and its microphone is audibly above the speaking threshold; the zone mirrors it into the existing `Activity.speaking` bit of the player's entity record (never for local-profile players, who are listen-only). Bit 15, not 14, so movement packages (WP10) can keep appending input flags from 14 without colliding.
2. **New cross-service message (Redis pub/sub, not a codegen contract):** the zone publishes earshot sets on `voice:{worldId}` as JSON. The Go type and the full field description live in `server/pkg/earshot` (shared by zone and social, the way `zoneregistry` is):

```json
{"v":1,"zone":"zone-dev-1","seq":42,"t":1762600000123.4,"full":false,
 "sets":{"<listener charId>":["<speaker charId>", "..."]},
 "gone":["<charId>"]}
```

`full` messages (every 8th, 2 s) list every player the zone owns; deltas list only listeners whose set changed; `gone` lists players who left. Spec 11 lists earshot sets on `social:{worldId}`; a dedicated channel is used because only one social process per world (the voice leader) needs them and they are the largest stream at 4 Hz per zone (decision 0011).

Regenerated with `npm run gen`: `contracts/ts/src/gen/protocol.ts`, `server/pkg/proto/protocol_gen.go`, `contracts/golden/protocol_vectors.json` (`PROTOCOL_VERSION` 2).

## Why

- Spec 9/10: "the speaking bit also rides in the zone protocol's activity flags so far players' silhouettes can show it". The zone owns entity records, so the client has to tell the zone; an input flag costs nothing (the flags field is already in every frame) and needs no new message.
- Spec 10/11: earshot sets flow zone → social over Redis pub/sub. A versioned, documented message keeps the two services from drifting.

## Consumers affected

| Consumer | Change |
| --- | --- |
| `server/zone` (WP03/WP06) | Mirrors `InputFlag.speaking` into `Activity.speaking` (`internal/game/earshot.go`, one line in `entity.go`); publishes earshot (`voice.go`, `internal/voice`) |
| `client/src/net` (WP06) | `NetPlay` ORs `voiceInputFlags()` into each frame; Hello sends `PROTOCOL_VERSION` 2 automatically |
| `tools/bots` (WP03) | None: they send `proto.ProtocolVersion` from the generated code, so they speak v2 after a rebuild |
| `client` movement / `server/pkg/movement` | None: movement tests flags bit by bit, bit 15 is ignored |
| `server/social` | Consumes `voice:{worldId}` (`server/social/voice`) |

The zone kicks clients whose `Hello.protocolVersion` differs, so a v1 client must be rebuilt (every client in the repo reads the generated constant). **Merge note:** if WP10 also bumps `protocol.yaml`, the merge takes the higher version + 1 and both flag additions; `speaking` stays at bit 15.
