# Lodestone Build Spec

Nov 8, 2026 · @Nicole

Lodestone (working title) is a browser-based, first-person open world RPG: a procedurally generated world that plays like Breath of the Wild crossed with modded Minecraft, with towns, structures, caves, gems and ores, demons that hunt at night, quick snappy combat, loot from common to Bitchin', parties, chat and proximity voice, shared by hundreds of players per world. This spec was written by Opus 5.5 for a series of Sonnet agents, each building one work package (section 15) at a time. Terms are defined in section 17.

> Repo note: this file is the verbatim build spec, committed so every package agent reads the same source. The two embedded diagrams of the original (system architecture, build roadmap) are described in prose in sections 4 and 15. Local deviations and decisions are recorded in `docs/decisions/` and `docs/STATUS.md`.

## 1. How to use this spec

Every agent reads sections 1 to 4 in full, then the sections its work package lists, then its work package. Nothing in a later section overrides section 2 (pillars and non-goals).

**Rules of engagement for every agent**

1. **One work package per session.** Branch `wp/NN-short-slug`, one PR, title `WP NN: <name>`.
2. **Stay inside your owned paths.** Each package lists the directories it owns. Read anything; write only there, plus `docs/STATUS.md` and your package's tests.
3. **Contracts are shared and versioned.** `contracts/` holds the wire protocol, the WorldSpec schema, shared constants and DB migrations. If your package needs a contract change, write `docs/cr/NNN-slug.md` (what, why, every consumer affected), make the change, bump the contract version, regenerate code, and fix every consumer in the same PR. Never fork a contract locally.
4. **Reference repos are read-only.** They are cloned into `refs/` (gitignored). Copy and adapt code with a one-line comment naming the source file, for example `// adapted from wizard-wars client/src/networking/ClientPrediction.ts`. Never import from `refs/`.
5. **Run what you build.** Unit tests are not enough. Start the services, open the client in a headless browser, and capture a screenshot or log that proves the acceptance criteria. Put the evidence in the PR description.
6. **Unattended means decide and record.** Nobody will answer questions mid-run. Take the most reasonable reading of this spec, list every assumption under "Assumptions" in the PR, and keep going. Stop only before something irreversible (deleting data, changing a contract's meaning rather than adding to it).
7. **Write comments that explain why.** The reference repos explain decisions in their comments (see the header of wizard-wars `server/src/GameLoop.js`). Match that: why a number is what it is, what broke before, what to watch.
8. **Budgets are tests.** Performance and bandwidth budgets in sections 9 and 12 are acceptance criteria, not aspirations. A package that touches a budgeted path adds or updates the measurement.

**Definition of done for every package**

- [ ] Acceptance criteria in section 15 pass and the evidence is in the PR
- [ ] Unit tests for logic, plus at least one integration test that crosses a process boundary when the package has one
- [ ] `docs/STATUS.md` updated: what works, what doesn't, known gaps
- [ ] A `README.md` in each package directory: what it is, how to run it, how to test it
- [ ] No new `TODO` without a matching line in `docs/STATUS.md`
- [ ] Lint and typecheck clean (TypeScript `strict`, `go vet`, `cargo clippy`)

## 2. Vision, pillars and non-goals

The game is about a generated world that feels alive: you see a strange peak, you go there, and something is waiting, and when night falls you had better be near a town. Play solo or in a party; parties are a social tool, not a requirement. All combat is against the world, never against other players.

**Pillars**

1. **If you can see it, you can go there.** Long draw distance, climb any surface steep enough, glide off anything high enough. Breath of the Wild is the north star for traversal; modded Minecraft is the north star for variety (towns, structures, biomes, ores, something odd over every hill).
2. **The world is generated, not authored, and it is never sent over the wire.** Seed plus WorldSpec plus generator version produces the same world on every machine. The network carries only changes.
3. **Combat is quick and snappy.** Fights take seconds, attacks come out instantly, you can always dodge. Not the slow, heavy commitment of Monster Hunter World or Elden Ring. Small fights are everywhere; boss battles are events.
4. **Elements live in the ground.** Eight elements (Fire, Ice, Lightning, Earth, Wind, Light, Dark, Void), each tied to a gem, and ores that make weapons. A region's character comes from what is in its rocks.
5. **Day is for exploring, night is for surviving.** Demons rise at dusk and only certain weapons and magic can kill them. Towns are warded safe havens.
6. **Play your way.** Magic from Wizard Wars, but also swords, spears and bows, each a skill you get good at by using it.
7. **Systems over scripts.** Fire spreads through dry grass and makes updrafts, ice freezes water into bridges, earth raises climbable pillars, rain makes rock slippery.
8. **Beauty is a feature.** Valheim-level light: sun rays through the trees, fog in the valleys, grass moving in the wind. The kind of game that gives you core memories just from how it feels to stand somewhere.
9. **Being with people.** Parties, chat, whispers and proximity voice make strangers feel present.
10. **Generative AI is the last resort.** Deterministic algorithms do the work. A language model may only fill one small, validated JSON object (the WorldSpec, section 6), and the game works fully without it.
11. **It runs in a browser tab, smoothly.** Performance budgets (section 12) beat visual ambition; precompute and preload everything we can.

**Non-goals (do not build these)**

- **Not a competitive FPS.** No hitscan-vs-player lag compensation; Wizard Wars' `LagCompensation.js` is not ported. *Amended by CR 019 (playtest 2, Nicole: "Add pvp option if not in the same party and duels if you are"):* PvP is opt-in (both players flagged, not in the same party, outside settlements and the Haven) and party members can duel; player hits use the same lenient PvE validation at half damage. Without a flag or a duel, players still cannot damage each other.
- **No trading in v1, but designed for it.** Players can drop items for others to pick up. Direct trades and markets come later; v1 items carry the fields and server hooks trading will need (section 8).
- No authored story or quest scripting system in v1. Discovery, towns' bounty boards, structures, caves, nights and loot are the loop.
- No player building or terraforming in v1 (see open questions).
- No mobile touch controls in v1. Desktop browsers with keyboard and mouse only; controller support is a stretch goal.
- No LLM calls at runtime per player, per frame or per chunk. Ever.
- No user-generated worlds in v1. Worlds are minted by the creator tool (section 6).
- **Inspired by, never copied.** Breath of the Wild, Minecraft, Valheim and Demon Slayer shape the feel. No names, terms, characters or designs from them appear in the game.

## 3. Reference repos

Three of Nicole's repos already solve large parts of this. Port their ideas and code; do not rewrite what works. Clone them into `refs/` at the start of every session: `github.com/nick5616/wizard-wars`, `github.com/nick5616/3d-portfolio-website`, `github.com/nick5616/the-circle`. (`npm run refs` does this.)

**wizard-wars**: the gameplay and netcode template. Authoritative Node server at 64 Hz, React Three Fiber client, Source-style movement, five spell schools with skill trees, a rich FX layer. It is built for one small arena with full-room JSON broadcasts, which is exactly what this game must outgrow.

| Source path | Take | Change for Lodestone |
| --- | --- | --- |
| `shared/movement.js`, `shared/constants.js` (movement block) | Ground/air acceleration, friction, double jump; the feel is tuned | Port to TS (client) and Go (server) from one constants file; add climb, glide, swim, stamina |
| `client/src/networking/ClientPrediction.ts`, `EntityInterpolation.ts`, `ClockSync.ts` | Prediction with reconciliation, interpolation buffer, NTP-style clock sync | Feed from the binary protocol; interpolation delay per AOI ring |
| `server/src/GameLoop.js` | Shared fixed-rate scheduler with spin tail, bounded catch-up | Reimplement in Go with the same reasoning (one grid, no per-room spin) |
| `shared/spells.js`, `shared/skillTrees.js`, `shared/leveling.js`, `server/src/systems/SpellSystem.js`, `ProgressionSystem.js` | Spell definitions, trees, level curve, cast logic | PvE only: targets are enemies and terrain, never players. The Sword school leaves magic and becomes a weapon skill (section 8) |
| `server/src/systems/BotAI.js`, `server/src/Bot.js` | Bot driving for soak tests and simple AI patterns | Split: test bots (players) vs enemy AI (section 8) |
| `client/src/components/spells/fx/*`, `LightPool.tsx`, `ShaderWarmup.tsx`, `stores/qualityStore.ts` | FX recipes, pooled lights, shader warmup, quality tiers | Keep; budget lights per chunk |
| `client/src/utils/crystalMaterial.ts`, `rupeeGeometry.ts`, `components/spells/GemPlopSpell.tsx` | Gem and crystal look | Basis for gems, ore veins and cave lighting |
| `client/src/audio/AudioManager.ts`, `soundManifest.ts` | Sound pipeline | Add spatial and cave reverb buses |
| `scripts/playtest/netsim-proxy.mjs`, `soak.mjs`, `browser-playtest.mjs` | Network impairment proxy, soak harness, headless playtests | Point at zone servers; scale to hundreds of bots |

**3d-portfolio-website**: the lightweight presence pattern. A deliberately non-authoritative presence and signaling server with a tiny binary pose format.

| Source path | Take | Change for Lodestone |
| --- | --- | --- |
| `src/multiplayer/protocol.ts` | Quantized binary pose (12 bytes), activity bits riding in the flags byte, the reasoning about latest-wins traffic vs reliable traffic | Basis for the snapshot entity record (section 9); keep the activity-bits idea for emotes and states |
| `multiplayer-server/server.mjs` | Presence, room census, per-connection message rate cap, reconnect behavior | Presence moves to the social service |
| `scripts/capture-screenshots.js` (puppeteer) | Headless capture | Perf and visual checks in CI |

**the-circle**: the voice and chat template. WebRTC mesh for up to 8 people, Django Channels signaling, Redis room state, a shared text chat.

| Source path | Take | Change for Lodestone |
| --- | --- | --- |
| `frontend/src/audio.ts` | One AudioContext, analyser per track, levels written to DOM outside React | Speaking indicators over heads and in the party frame |
| `frontend/src/rtc.ts` | Declarative reconcile of who should be connected, stale-connection ids, escalating self-healing | Same reconcile idea, but against SFU subscriptions instead of peer links (section 10) |
| `backend/rooms/ice.py` | STUN plus time-limited HMAC TURN credentials delivered at connect | Same pattern for the voice service |
| `backend/rooms/consumers.py` (token bucket), `room_state.py` (capped Redis chat list, session reaping) | Rate limiting, chat history, dead-session cleanup | Port to the Go social service |
| `frontend/src/components/Chat.tsx` | Chat UI behavior | Channel tabs, whisper, party |
| `e2e/netem.sh`, `e2e/soak.mjs` | Real packet impairment profiles ("thailand", "mobile"), many fake clients with fake media | Voice soak tests |

Why not mesh voice like The Circle: proximity voice can mean 12 people in earshot. A mesh makes each player upload 11 copies of their voice and exposes everyone's IP to strangers. An SFU fixes both (section 10).

## 4. Architecture

The client holds three connections: one to the zone server it stands in (game state), one to the social service (chat, parties, presence), and one to the voice SFU. Worldgen runs as the same WebAssembly binary in the browser and on the zone server, which is what lets the world stay off the wire.

(Diagram, in prose: the browser client talks HTTPS to the Director and Account service, a binary WebTransport/WebSocket connection to its Zone server, a JSON WebSocket to the Social service and WebRTC to LiveKit. The Zone server and the client both load `worldgen.wasm`. Earshot sets flow from the zone server to the social service, which sets LiveKit subscriptions. All Go services share Postgres and Redis.)

| Component | Language | Responsibility | Talks to |
| --- | --- | --- | --- |
| Client | TypeScript, React, Three.js, React Three Fiber, Web Workers | Rendering, input, prediction, chunk streaming, UI, spatial audio | Director (HTTPS), zone server, social service, LiveKit |
| Worldgen core | Rust compiled to `wasm32-unknown-unknown` | Deterministic chunk generation: terrain, biomes, caves, ore, POIs, loot container placement | Loaded by client workers and by zone servers via wazero |
| Director | Go, HTTPS | Login handoff, world list, assigns a player to a zone server, issues signed connect tickets | Account service, Redis zone registry |
| Zone server | Go | Authoritative simulation for a set of regions: players, enemies, spells, loot rolls, world edits, AOI | Client, Redis, Postgres, social service, other zone servers |
| Social service | Go | Chat channels, parties, friends, presence, moderation, voice tokens | Client (WebSocket), Redis, Postgres, LiveKit server API |
| Voice | LiveKit (self-hosted, open source SFU) | Media routing; subscriptions set by the social service | Client (WebRTC), social service |
| Account service | Go, HTTPS | Auth (OAuth sign-in via Firebase Auth, signing save blobs for local profiles), characters, inventory reads | Postgres |
| Creator tool | TypeScript web app plus a Go endpoint | Mint worlds: WorldSpec editing, previews, optional LLM fill | Account service, worldgen core |
| Postgres |  | Durable state: accounts, characters, items, worlds, world edit log |  |
| Redis |  | Ephemeral state: presence, parties, chat buffers, zone registry, pub/sub |  |

**Repository layout** (a single monorepo; package managers: npm workspaces, Go workspace, Cargo)

```
lodestone/
  contracts/        protocol.yaml, worldspec.schema.json, constants.yaml, migrations/, codegen/
  worldgen/         Rust crate -> worldgen.wasm, plus determinism harness
  client/           Vite + React + R3F app
  server/
    director/       Go
    zone/           Go
    social/         Go
    account/        Go
    pkg/            shared Go packages (generated protocol, constants, wasm host)
  tools/
    creator/        WorldSpec creator tool
    bots/           headless bot clients (Go) for soak tests
    netsim/         impairment proxy and netem profiles
  infra/            docker-compose for local, deploy scripts
  docs/             STATUS.md, cr/, decisions/
  refs/             gitignored reference repo clones
```

**Local development works the same on Windows and Linux.** One command, `npm run dev`, starts Postgres, Redis and LiveKit in Docker, then the Go services and the Vite client. `npm run dev:solo` runs the client plus worldgen only, no servers, for terrain and rendering work (wizard-wars' `dev:mock` idea).

- Every script is Node (`.mjs`) or Go. No bash-only or PowerShell-only scripts; `npm run` is the entry point for everything.
- Docker Desktop with the WSL2 backend on Windows, Docker Engine on Linux. Linux-only tools, like the-circle's `netem.sh` packet impairment, run inside a Linux container on both.
- Go and Rust run natively on both. `rust-toolchain.toml` pins the Rust version and the `wasm32-unknown-unknown` target; `go.work` pins Go modules.
- `.gitattributes` forces LF line endings. No symlinks in the repo. Paths always go through `path.join` or `filepath.Join`. Every port is configurable by environment variable.
- CI runs the build and tests on both `ubuntu-latest` and `windows-latest`.
- Measure the zone scheduler's tick jitter on both operating systems. wizard-wars' `GameLoop.js` explains why Windows timers need a longer spin tail; keep that behavior configurable in Go.

## 5. World generation and determinism

A world is fully defined by `(seed, WorldSpec, genVersion)`. Generation runs in two passes: a world-level atlas computed once when the world is minted, and per-chunk detail computed on demand by whoever needs it. Every output is bit-identical on every machine.

**Units and coordinates**

- 1 unit = 1 meter. Y is up.
- Chunk: 64 m x 64 m column. Region: 16 x 16 chunks (1024 m). v1 world: 4 x 4 regions (4096 m square, about 16.8 km²). Vertical range: -256 m (deepest cave) to +768 m (highest peak).
- Chunk ids are `(cx, cz)` integers; cave volume cells are `(cx, cy, cz)` with 32 m vertical cells.

**Determinism rules (non-negotiable)**

1. One Rust crate, compiled once to one `worldgen.wasm`, executed unchanged by the browser (in workers), by Node (tests) and by Go zone servers (via wazero). Core WebAssembly float arithmetic is deterministic across hosts; that is the whole strategy.
2. No host-imported math. `sin`, `exp`, `pow` and friends come from Rust `libm` compiled into the module. Never call out to JavaScript `Math` or Go `math`.
3. No threads, no relaxed SIMD, no wall-clock, no host randomness inside the module. Randomness is a counter-based hash (for example PCG or SplitMix64) of `(seed, stream, x, y, z)`, never a stateful RNG shared across chunks, so chunks generate in any order with identical results.
4. NaN never appears in output. Debug builds assert it; NaN payload bits are the one place hosts may differ.
5. Every output buffer has a 64-bit content hash. `worldgen/golden/` holds a table of `(seed, spec, genVersion, chunk) -> hash` for at least 200 chunks spanning every biome, caves and ore. CI checks it in all three hosts.
6. A world pins its `genVersion` forever. Changing generator output means a new major version; old wasm builds stay deployable by hash so old worlds never shift under players.

**Pass 1: the atlas (once per world, at mint)**

- Continent mask and macro heightmap at 32 m resolution, shaped by WorldSpec terrain fields.
- Hydrology: flow accumulation on the macro map carves rivers and places lakes; sea level from the spec.
- Climate: temperature from altitude plus a spec-driven gradient, moisture from distance to water and prevailing wind. Biome = lookup on (temperature, moisture, altitude).
- v1 biomes: meadow, forest, highlands, snowpeak, badlands, wetland. Each defines palette, scatter sets, flammability, enemy tables and loot themes.
- Points of interest (towns, roads, towers, cave mouths, structures, enemy camps, demon lairs, waypoints, landmarks) placed by visibility (below).
- Output: a compact binary atlas, budget 2 MB gzipped. The client downloads it once and caches it in IndexedDB by hash; it can also regenerate it locally, and the golden tests prove both give the same bytes.

**Placing points of interest by visibility**

This is how the world gets Breath of the Wild's pull without hand placement. Candidate sites come from ridges, peaks, valley mouths and river bends. For each candidate, compute a viewshed on the macro heightmap and score it by how much likely-travel area can see it. Then place greedily under these rules:

- Every region gets at least one tower, chosen for the largest viewshed. Climbing it reveals that region's map.
- From any walkable point, at least one undiscovered POI is visible within roughly 800 m. Fill gaps until this holds or the region's POI budget runs out.
- Hills hide things: prefer cave mouths and ruins just behind a ridge from a tower, so the reveal happens as you crest it.
- Spacing minimums per POI type keep the world from clumping.

**Pass 2: chunk detail (on demand)**

- Heightfield at 1 m spacing (65 x 65 samples) from the macro map plus erosion-shaped detail noise. Coarser LOD levels sample the same function at 2, 4, 8 m and so on, so seams match.
- Material splat weights per sample (grass, dirt, rock, snow, sand, mud), slope-aware.
- Scatter (trees, rocks, bushes, grass tufts) by seeded Poisson-disk per chunk. Every scattered object gets a stable id `hash(cx, cz, layer, index)` so world edits can name it ("tree 0x9f3a burned").
- Loot containers and enemy spawn anchors also get stable ids from the same scheme.
- Budget: one detail chunk in under 8 ms in a browser worker on a mid-range laptop; a cave volume cell in under 12 ms.

**Towns, roads and structures (the modded Minecraft layer)**

Towns and structures are generated at mint as part of the atlas, from modular pieces, so every world has its own villages and ruins without anyone placing them.

- **Settlements:** sites scored for flat ground, fresh water, shelter and distance from other towns; spec field `settlementDensity` sets how many. Sizes: hamlet (4 to 8 buildings), village (10 to 25), town (30 to 60, walled). Every region gets at least one hamlet or larger.
- **Roads:** least-cost paths between settlements over the macro heightmap (slope, water and biome costs), smoothed and flattened into the terrain, with generated bridges at river crossings and signposts at forks. Roads are the safe-ish routes at night.
- **Town layout:** plots subdivided along roads, a central square, and required buildings first: forge, inn, market stalls, bounty board, ward garden (section 8), a waypoint stone. Remaining plots become houses, farms and workshops.
- **Buildings from a kit:** each biome has a building style (timber in forest, stone in highlands, adobe in badlands, stilt houses in wetland, log cabins in snowpeak). A shape grammar assembles footprints, floors, roofs, windows and porches from that style's modular pieces, then fills interiors from furniture sets. Pieces share one texture atlas per style so a whole town draws in a handful of draw calls.
- **Structures:** a library of templates assembled jigsaw-style (pieces with typed connectors, placed until a size budget is reached), weighted per biome and region element. v1 set: ruins, watchtowers, abandoned mineshafts (which connect into cave systems), shrines, bandit camps, wizard towers, meteor craters (starmetal ore), sunken temples, demon lairs. Spec field `structureDensity` scales how many.
- **NPCs** live in towns only, with simple daily schedules (out by day, indoors at night): merchants, a blacksmith (smelting, forging, socketing), an innkeeper and a bounty keeper whose board offers generated jobs ("clear the bandit camp to the north", "bring 5 iron ingots", "slay the demon that haunts the mill").
- Every building, structure piece, door, chest and NPC gets a stable id from the same hashing scheme as scatter, so world edits and per-character progress can name them.
- Generation budget: all settlements, roads and structure placements for a v1 world in under 60 s at mint. Clients receive them inside the atlas; building meshes are assembled in workers from the kit on demand.

**Exported wasm API** (flat buffers in linear memory; no JSON on the hot path)

| Export | Returns |
| --- | --- |
| `atlas_build(spec_ptr, spec_len, seed_lo, seed_hi)` | Atlas buffer pointer and length |
| `chunk_build(atlas_ptr, cx, cz, lod)` | Heights, splat weights, scatter list, container and spawn anchors |
| `cave_build(atlas_ptr, cx, cy, cz)` | Density field (33 x 33 x 17 samples at 2 m), ore vein list |
| `collision_height(atlas_ptr, x, z)` | Ground height at a point, for the server's fast path |
| `hash_buffer(ptr, len)` | 64-bit content hash |

**Keeping old worlds working: generator maintenance**

Players log into the same world for years and must always see the same mountains. What makes that work is pinning the compiled file, not the source code.

1. **The pinned thing is `worldgen-<hash>.wasm`,** a few megabytes, stored in object storage forever and cached by every browser by hash. WebAssembly is a stable standard, and browsers and wazero keep running old modules unchanged, so the same file gives the same world in five years.
2. **Only shape is pinned.** Terrain, caves, towns, structures and placement live in the pinned wasm. Combat, loot tables, enemies, UI, rendering and everything else update freely with normal deploys.
3. **Changes that don't alter output** (speedups, refactors, new exports) must leave every golden hash unchanged for that version. If CI proves that, the new build can replace the old one for those worlds.
4. **Changes that alter output** (a bug fix in rivers, a new structure type) become a new `genVersion`. New worlds use it; existing worlds stay on theirs.
5. **Moving an old world to a new generator** is a deliberate, rare "world renewal": regenerate, carry player progress across by stable ids where they still exist, refund what doesn't, and announce it in advance.
6. **Ongoing maintenance is small:** CI runs golden tests for every version still used by a live world; each version has a git tag and its pinned toolchain so it can be rebuilt bit for bit; a version is retired only when no world uses it. Nothing needs doing on a schedule unless the generator changes.

## 6. WorldSpec and the GenAI surface

The WorldSpec is the only thing a language model is ever allowed to produce, it is about 35 numbers and tags, and the default way to make one uses no model at all.

**The schema** lives at `contracts/worldspec.schema.json` (JSON Schema draft 2020-12) with `"additionalProperties": false` everywhere. v1 fields, grouped:

| Group | Fields (type, range) |
| --- | --- |
| Identity | `specVersion` (int), `name` (string, 3 to 40 chars), `seed` (uint64 as string) |
| Terrain | `seaLevel` (0 to 1), `landFraction` (0.3 to 0.9), `mountainHeight` (0 to 1), `roughness` (0 to 1), `plateaus` (0 to 1), `riverDensity` (0 to 1) |
| Climate | `temperatureBias` (-1 to 1), `moistureBias` (-1 to 1), `windDirection` (0 to 359 degrees), `stormFrequency` (0 to 1) |
| Biomes | `biomeWeights` (object of the six v1 biomes, each 0 to 1, renormalized), `elementWeights` (object of the eight elements, each 0 to 1; sets each region's elemental character, section 7) |
| Underground | `caveDensity` (0 to 1), `caveMaxDepth` (64 to 256 m), `gemRarityCurve` (0.5 to 3, exponent on depth), `oreAbundance` (0 to 1) |
| Danger | `dangerCurve` (0 to 1, how fast difficulty rises from spawn), `enemyDensity` (0 to 1), `demonIntensity` (0 to 1, how dangerous nights are) |
| Systems | `flammability` (0 to 1), `nightLength` (0.2 to 0.6 of a day), `settlementDensity` (0 to 1), `structureDensity` (0 to 1) |
| Flavor | `palette` (one of a fixed list), `lootThemes` (up to 4 tags from a fixed vocabulary), `nameGrammar` (one of a fixed list of Tracery-style grammars) |

Every free-text field is either a fixed enum or the world's display name. There is nowhere for a model to inject prose that reaches players.

**Three ways to make a spec, in order of preference**

1. **From the seed alone.** `spec_from_seed(seed)` in the worldgen crate picks every field deterministically, within tasteful ranges. This is the default and needs nothing else.
2. **Presets plus sliders** in the creator tool. Presets like "Archipelago", "Highland", "Badlands". Each slider shows a live 2D atlas preview, generated by the same wasm in the browser.
3. **Vibe text (optional, last resort).** The creator types something like "drowned cathedral archipelago, cold, lots of caves". The server makes one call to a small Claude model with structured output constrained to the schema, then:
   - validates against the schema and rejects on any failure (no repair loop beyond one retry);
   - clamps every number to its range and drops unknown tags;
   - caches the result by `sha256(normalized prompt + specVersion)`;
   - shows the creator the resulting sliders, which they can still adjust before minting.

The LLM path sits behind a feature flag and an API key in the creator tool's server only. It never runs for players, at runtime, or per chunk. If the flag is off or the call fails, the tool falls back to option 2 with a short notice.

Place and item names come from seeded grammars in the crate (for example "the {adjective} {landform} of {name}"), not from a model. Minting stores `(seed, spec, genVersion, atlasHash)` in Postgres; that row is the world.

## 7. Caves, gems and mining

The overworld is a heightfield and the underground is a density volume. Heightfields give cheap long-distance LOD, which the "see it, go there" pillar depends on; volumes give overhangs and tunnels, which caves need. Caves are generated as a graph first, so every chamber is reachable.

**Cave generation**

1. **Graph first.** From each cave mouth in the atlas, grow a graph of chambers (nodes with radius and depth) and tunnels (edges with width and curvature), within the spec's `caveDensity` and `caveMaxDepth`. Connectivity is guaranteed by construction, and the graph doubles as the enemy navigation graph.
2. **Rasterize to density.** Chambers become smooth blobs, tunnels become swept capsules with noise, plus occasional ravines. Density samples every 2 m in 32 m vertical cells.
3. **Mesh with surface nets** inside the wasm crate, so the client and the server get identical triangles. Only cells within about 96 m of a player who is underground or near a mouth are meshed.
4. **Depth bands:** shallow (0 to 64 m), mid (64 to 160 m), deep (160 to 256 m). Deeper means darker, tighter, more dangerous and richer.

**Cave mouths.** The overworld chunk carries a mouth mask that removes heightfield triangles where the volume breaks the surface. A generated rock-arch prop sits over every mouth to hide the seam; this is cheaper and more reliable than stitching two meshing schemes.

**Light and sound underground.** No sun or sky light below ground: ambient drops near black. Light comes from glowing gems and fungi (emissive, nearly free), the player's staff glow, and spells. Pooled point lights are capped at 8 near the camera, using wizard-wars' `LightPool`. Audio switches to a reverb bus sized by the current chamber's radius from the graph.

**Elements and gems.** The world's eight elements live in its rocks: each has a gem, found in the ground, that powers its magic and can be socketed into gear.

Every region rolls a dominant and a secondary element from the spec's `elementWeights` and its biome. That choice sets which gems and ores its caves hold, which elements its enemies use, its weather flavor (lightning storms over topaz highlands, strong updrafts on aquamarine plateaus) and accent colors in its structures. You can read a region's character from what you mine there.

| Element | Gem | Richest in | What it does |
| --- | --- | --- | --- |
| Fire | Ruby | Badlands, volcanic caves | Burns, spreads, makes updrafts |
| Ice | Sapphire | Snowpeak caves | Freezes enemies and water |
| Lightning | Topaz | Highland storms, mid caves | Chains through water and metal, stuns |
| Earth | Emerald | Forest and wetland, shallow to mid | Pillars, walls, faster mining |
| Wind | Aquamarine | High plateaus and cliffs | Gusts, knockback, glide boosts |
| Light | Sunstone | Peaks and sunlit sinkholes | Heals, reveals, burns demons |
| Dark | Onyx | Deep caves | Curses and drains (Wizard Wars' Dark school) |
| Void | Amethyst | Deepest band, void rifts | Pulls, blinks, erases; the rarest |

Two utility gems sit outside the elements: **Opal** (loot find) and **Moonstone** (stamina and night sight).

Gem chance at a vein scales with `depth ^ gemRarityCurve`, then by biome affinity. Gems come in three cuts (rough, cut, brilliant); three of a cut combine into the next at a waypoint.

**Ores.** Gems power magic; ores make weapons and armor. Ore is smelted into ingots at a town forge, then forged from blueprints that are found in structures or bought from blacksmiths.

| Ore | Where | Makes |
| --- | --- | --- |
| Copper | Shallow, everywhere | Starter tools and arrowheads |
| Iron | Shallow to mid | Standard weapons and armor |
| Silver | Mid | Weapons that stagger demons longer (they still can't kill them) |
| Sunsteel ore | Mid to deep, only in veins that touch daylight (sinkholes, caves near peaks) | Sunsteel blades and arrowheads, the only weapons that kill demons |
| Starmetal | Meteor craters | Bases for relic and higher weapons |
| Voidglass | Deepest band, void rifts | Void weapons, bases for primordial gear |

**Mining**

- Ore veins are clusters on chamber walls, each with a stable id from the generator. A vein has hit points and takes damage from Earth spells, any spell's impact at half rate, or a pickaxe tool.
- When a vein breaks, the zone server rolls drops (the client never decides), spawns them as pickups, and records a world edit: `vein_mined(id, respawnAt)`. Veins respawn after a seeded 6 to 24 hours of real time.
- Mining also carves a small sphere (1.5 m radius) from the density field around the vein, recorded with the same edit and restored when the vein respawns. This keeps the edit log bounded: the underground never becomes permanent Swiss cheese.
- Ore and loot drops are personal per player (section 8), so two people mining together never fight over a gem.

**World edits in general.** Every change to generated content is an entry in a per-chunk append-only edit log: `{editId, chunk, kind, targetId, params, tick, expiresAt}`. Kinds in v1: `vein_mined`, `object_burned`, `object_frozen`, `object_destroyed`, `pillar_raised`. Almost every edit expires (burned grass regrows in an in-game day, pillars crumble after 2 minutes), so the active set per chunk stays small. A client entering a chunk's interest area gets its active edits once, then live deltas.

## 8. Gameplay systems

The loop is: spot something, travel there, fight what lives there in a few quick seconds, take what it guards, mine and forge, get back to a town before dark, get stronger, spot something farther. Everything is PvE; players can help each other but never hurt each other.

**Movement**

- Base movement is wizard-wars' Source-style ground and air acceleration, friction, sprint and double jump, ported from `shared/movement.js` with the same constants file feeding the TS client and the Go server.
- **Climb** any surface between 50 and 89 degrees by holding forward into it. Climbing speed 2 m/s, a climb-jump lunge costs a chunk of stamina. Rain halves climb speed and makes you slip back every few seconds, so weather matters.
- **Glide** from any fall longer than 1.5 m by pressing jump in the air. Glide sink rate 2 m/s, horizontal 9 m/s, steerable. Fire's rising heat gives an updraft column you can ride.
- **Swim** at the surface; stamina drains, and drowning at zero respawns you at the shore.
- **Stamina** is one wheel: sprint, climb, glide and swim drain it; standing on ground refills it after 1 s. Upgrades come from rare finds at towers and deep caves.
- **Collision queries live in the wasm crate** (capsule sweep, raycast, ground height) against both heightfield and cave meshes, so client prediction and the server agree almost exactly. Movement integration runs in TS and Go from shared constants. Rapier is not used for player movement; it may be used client-side for cosmetic physics (falling rocks, loot bounce).

**Combat feel: quick and snappy**

Combat should feel closer to an action game than to Monster Hunter World or Elden Ring: attacks come out the instant you press, nothing locks you into a long animation, and you can almost always dodge. These numbers are acceptance criteria.

| Measure | Target |
| --- | --- |
| Light attack startup | 100 ms or less |
| Recovery after a light attack | 250 ms or less; cancelable into a dodge once its hit frames end |
| Dodge | Available almost anytime; 150 ms of invulnerability |
| Input buffer | 150 ms, so presses during an animation are never lost |
| Hitstop on a hit | 40 to 80 ms, local only, never pauses the world |
| Using a consumable | 400 ms or less, and you can walk while doing it |
| Enemy wind-ups | 300 to 600 ms, readable, never longer |
| Common enemy | Dies in 2 to 5 hits; the fight lasts 3 to 10 s |
| Elite | 10 to 30 s |
| Boss | 2 to 5 minutes, 2 or 3 phases |

- Hit feedback (spark, sound, hitstop) plays instantly from the client's prediction; the server confirms and sends damage numbers. A rejected hit just shows no damage number.
- Mobility in combat: sprint attacks, air attacks, a plunge attack from any height, attacks out of a glide.
- No slow motion, because the world is shared. The bow's focus steadies your aim instead.

**Weapons and skills: not everything is wizard-based**

- **Loadout:** one weapon in the main hand and up to four spells cast from the off hand. Two saved loadouts, swapped instantly.
- **v1 weapons:** sword (fast combos, parry), spear (reach, thrusts, pole-vault), bow (charge for range and damage; arrows made from ore, with gem tips for elements), staff and wand (weak in melee, boost spell power, Wizard Wars-style casting).
- **Skills grow by use,** 1 to 100: Swordsmanship, Spearmanship, Archery, Spellcraft, Mining and Smithing. Every 10 levels unlocks a technique (archery: quick-draw, double shot, charged pierce, arrow rain; sword: parry riposte, dash cut, elemental forms).
- **Elemental forms:** weapon techniques powered by the socketed gem's element. For example, a Wind form dash that carries you 8 m, or a Fire form spinning slash that sets the grass alight. Original names, approved by Nicole.
- Character level (from XP) still exists for health and spell skill points. Weapon skills are separate and never gated by level.

**Magic**

- Wizard Wars' Fire, Ice, Dark and Earth trees are ported with their spells. Its Sword school moves out of magic into weapon skills.
- New trees for Lightning, Wind, Light and Void, each with a mobility spell, 3 to 5 core spells, a domain expansion and a pinnacle. Names follow the Wizard Wars naming philosophy and need Nicole's sign-off.
- Learn spells from tomes (structures, bounties, bosses) and skill points; equip any four, from any trees.
- *Added by CR 020 (playtest 2):* generic spell mechanics any spell can carry in combat.yaml: homing (seeks a target in a cone; the server re-flies the same path), hold-to-fire streams (up to 15 shots/s, mana per shot; the wire carries only start and stop), rain, hold-to-empower charges, orbiting orbs, delayed charges and chain-reaction brands, and summoned allies (server-side, capped per player, PvP only under the PvP rules). Fourteen spells across the trees use them; a stream and a seeker are learnable on a new character's first skill point.
- Light is the anti-demon school: its damage kills demons the way sunsteel does.
- Spells hit enemies and terrain only; projectiles pass through players. One-shot spells like Death Note work on non-boss enemies only.
- Experience comes from discovery (towers, caves, structures, towns) as much as from combat, so explorers level too.

**Systems (the chemistry engine)**

Each chunk carries a coarse 2 m grid of material states for flammable and freezable things, derived from scatter and biome. Interactions in v1:

| Cause | Effect |
| --- | --- |
| Fire on dry grass or wood | Spreads cell to cell along the wind; creates an updraft column; burns out in about 20 s; regrows in an in-game day |
| Ice on water | Freezes a walkable sheet for 60 s |
| Ice on burning cells | Extinguishes |
| Earth spell on ground | Raises a climbable pillar or wall for 2 minutes |
| Rain | Puts out fires, slows climbing, makes lightning-type effects chain across water |
| Fire near ice sheet | Melts it early |

Sync events, not results: the server broadcasts `ignite(cell, tick)` and every client runs the same spread from the seeded wind field. The server stays authoritative for damage and for the edit log. If spread desyncs prove noticeable, the fallback is server-sent burned-cell bitmaps per chunk at 2 Hz; keep both paths behind one interface.

**Fights and bosses**

- **Small fights everywhere:** roaming packs of 2 to 5, camps at structures, cave dwellers, ambushes on roads. Each biome, depth band and region element has its own enemy table.
- **Elites:** tougher variants with an element and an affix (fast, shielded, splitting) at structures and in deeper caves.
- **Bosses** live at the heart of large cave systems, sunken temples, wizard towers and demon lairs. The generator supplies the arena (a cave chamber, a temple hall). Each has 2 or 3 phases, big telegraphed attacks and adds. Loot is personal with a weekly per-character lockout; the boss respawns 1 real hour after a kill so others get their turn.
- Enemies sleep until a player is within 96 m, then simulate on the zone server as simple state machines (idle, patrol, alert, chase, attack, flee, return) on the cave graph or a coarse overworld nav grid.
- Health and damage scale with the number of players nearby, so a party of four and a solo player both get a fair fight.

**Night and demons**

- At dusk, demons rise from shadowed ground, caves and lairs. A seeded 8-night moon cycle sets how many; new-moon nights are the worst. The spec's `demonIntensity` scales all of it.
- Demons regenerate from ordinary damage: other weapons and spells only stagger and push them back. Only **sunsteel** weapons, **Light** magic or **sunrise** kill them. Dawn burns any demon caught in the open; the rest flee to caves and lairs.
- **Towns are warded** by gardens of a flowering plant demons cannot pass, and lanterns line the main roads. On some nights a town's ward weakens and demons attack: a town defense event anyone nearby can join.
- **Ranks:** lesser demons (packs), greater demons (each with a unique element-based ability), demon lords (night bosses that roam on new moons).
- **Night rewards:** demon horns and essence for crafting, bounty payouts, and the best odds at mythic artifact and above.
- Inspired by Demon Slayer, never copied: no names, ranks, techniques or character designs from it.

**Loot, rarities and dropping items**

Eight rarity tiers. The odds are per roll at the base; item level, source (boss, demon lord, deep cave) and Opal gems shift them upward.

| Rarity | Color | Affixes | Base odds per roll | Typical source |
| --- | --- | --- | --- | --- |
| Common | Grey | 0 | 60% | Everywhere |
| Uncommon | Green | 1 | 25% | Everywhere |
| Rare | Blue | 2 | 10% | Camps, chests |
| Relic | Purple | 3 | 4% | Structures, elites |
| Legendary | Orange | 3 plus a unique effect | 0.9% | Bosses, deep caves |
| Mythic Artifact | Red | 4 plus a named unique | 0.09% | Bosses, demon lords |
| Primordial | White-gold | 5 plus a unique, on a starmetal or voidglass base | 0.009% | Deep bosses, void rifts |
| Bitchin' | Animated holographic | 5 plus two uniques, its own glow and sound | 0.0001% (about 1 in a million) | Anywhere; announced to the whole world in global chat |

- **Personal loot:** every chest, vein and kill rolls separately for each eligible player. Chests open once per character (a per-character bitset of container ids), not once per world.
- Weapons roll affixes from tables keyed by element and loot theme, plus 0 to 3 gem sockets. Socketing is free; unsocketing destroys the gem unless done at a town blacksmith.
- Other items: armor (head, body, legs), consumables (cooked at campfires and inns from foraged ingredients), spell tomes, blueprints, key items.
- Inventory: 40 slots plus a gem pouch and an ore pouch. All rolls happen on the zone server with a per-roll seed logged for audit.
- **Dropping:** drag an item out of the inventory or press a key to drop it. It becomes a world pickup anyone nearby can see and take for 10 minutes, then despawns. In v1 this is how players give each other things.
- **Built for trading later:** every item carries `tradeable` and a `provenance` list (who rolled it and every hand it has passed through). Drops already move items through one server path, `TransferItem(from, to, reason)`, which trades will reuse. Items dropped by a local-profile player (section 11) are marked unverified and won't be tradeable.

**Exploration structure**

- **Towers:** climb to the top to reveal the region's map and unlock it as a fast-travel point.
- **Waypoints:** smaller fast-travel stones at major POIs, activated by touching. Death respawns you at the last waypoint you touched, keeping everything.
- **Map and compass:** unrevealed regions are blank; the compass shows party members and pinned markers. Players can drop up to 10 personal pins; party pins are shared.
- **Day, night and weather** are functions of world time and the seed, so they need no sync beyond the clock. A day is 60 real minutes. Night brings demons (above) and makes gems glow brighter.

## 9. Netcode and interest management

The server is authoritative for everything; the client predicts only its own movement and interpolates everyone else. Because there is no PvP, the netcode trades Counter-Strike precision for scale: 30 Hz simulation, distance-tiered updates, binary deltas, and lenient hit validation that favors the player.

**Rates**

- Zone simulation: 30 Hz. Port the wizard-wars scheduler's reasoning (one shared grid, bounded catch-up) to Go.
- Client input: sampled at 60 Hz, sent 30 times a second with the last 3 inputs repeated in every packet, so a lost datagram costs nothing.
- Interpolation delay for remote entities: 100 ms in the near ring (as in wizard-wars), longer for slower rings.

**Interest management.** The zone divides space into 32 m cells. Each tick, a client's interest set is recomputed from the cells around it, in rings:

| Ring | Distance | What is sent | Rate |
| --- | --- | --- | --- |
| Near | 0 to 64 m | Players, enemies, projectiles, pickups, chemistry events | 30 Hz |
| Mid | 64 to 200 m | Players, enemies, large effects | 10 Hz |
| Far | 200 to 600 m | Players only, position and activity flags, for silhouettes and nameplates | 2 Hz |
| Party | Any distance | Party members' position and health | 2 Hz |

Underground, the interest set is clipped to the current cave system plus its mouths: someone in a cave does not receive the meadow above.

**Wire protocol**

- Defined once in `contracts/protocol.yaml`; a generator in `contracts/codegen/` emits TypeScript and Go encoders and decoders plus golden byte vectors tested on both sides. Hand-edited codecs are not allowed.
- Snapshots are deltas against the last snapshot the client acknowledged (per-client baseline ring of 32). Entity records carry a field mask, so unchanged fields cost nothing. This generalizes wizard-wars' cold-field wire cache.
- Quantization follows the portfolio's pose format in spirit: positions as int32 centimeters, yaw and pitch as one byte each, velocity as int16 cm/s, health as a byte of percent for others and exact for yourself. Activity bits (climbing, gliding, swimming, casting, emoting, typing, speaking) ride in a flags byte, as in `protocol.ts`.
- Three delivery classes: **unreliable latest-wins** (snapshots, input), **reliable ordered** (inventory, loot, quest-like events, zone transfer), **reliable per chunk** (world edits).

**Transport.** WebTransport over HTTP/3 (Go: `quic-go/webtransport-go`), with datagrams for the unreliable class and streams for the reliable ones. WebSocket fallback carrying the same binary frames is mandatory, because browser support for WebTransport varies; verify current Safari status at implementation time and record it in `docs/decisions/`. The client picks the transport at connect and reports it in the debug HUD.

**Combat validation (PvE, favor the player).** The client sends a hit claim with the spell, target and tick. The server accepts it if the target was within range and line of sight at any point in the last 250 ms of its position history. This is a deliberately cheap cousin of wizard-wars' lag compensation, sized for fighting monsters, not people.

**Zones and handoff**

- A zone server process owns a set of regions, assigned by the director through the Redis zone registry. Start with one process owning the whole v1 world; split by region when load requires.
- Entities within 64 m of a region boundary are mirrored read-only to the neighboring zone (a ghost band), so players see across the line.
- When a player enters the ghost band, the client pre-connects to the next zone with a ticket; ownership transfers when they cross. The player never sees a loading screen.
- A lightweight world presence feed (every player's position once per second, in Redis) supplies far-ring players who live on another zone.

**Security**

- Connect tickets are Ed25519-signed by the director: account, character, zone, expiry 60 s.
- Per-message-type token buckets on every connection (the-circle's `consumers.py` pattern). Movement is validated against max speed for the player's current mode; violations snap the player back.

**Budgets (acceptance criteria)**

| Measure | Budget |
| --- | --- |
| Client downlink, typical exploring | 64 kbps or less |
| Client downlink, 100 players in view | 160 kbps or less |
| Client uplink, excluding voice | 24 kbps or less |
| Zone tick time, p99, 300 players and 2,000 awake enemies, 4 vCPU | 12 ms or less |
| Soft cap per region | 150 players |
| v1 target per world | 1,000 concurrent players |

## 10. Social: chat, whispers, parties and proximity voice

The social service is one Go process per world, reached over its own WebSocket (JSON messages defined in `contracts/`, low volume, like the-circle's socket). It is independent of zones, so chat, whispers and parties keep working while a player crosses zone boundaries.

**Chat channels**

| Channel | Who hears it | How to use | History kept |
| --- | --- | --- | --- |
| Global | Everyone in the world | Global tab, `/g` | Last 200 messages |
| Zone | Everyone in your current region | Zone tab, `/z` | Last 100 |
| Local | Players within 30 m; also shown as a speech bubble over your head for 6 s | Default when typing in the world, `/s` | None |
| Party | Your party | Party tab, `/p` | Last 100 |
| Whisper | One other player, anywhere in the world, any zone | `/w Name message`, `/r` replies to the last whisper, or right-click a player or friend and choose Whisper | Last 100 per conversation, 24 h |
| System | You | Loot, discoveries, errors | Last 50 |

**Whispers in detail**

- Address by character name (case-insensitive, autocompleted from friends, party and nearby players). The social service resolves the name to an online session through Redis presence.
- Each whisper conversation gets its own tab that opens on first message and shows unread counts. Whisper sounds and a toast fire when the chat is closed.
- Offline target: the sender sees "Name is offline" and the message is not stored. Offline mail is out of scope for v1.
- Blocking someone stops their whispers silently (they see "delivered"), along with their chat in every channel and their voice.
- Local-profile players (section 11) can whisper only party members and friends.

**Parties**

- Up to 4 players (the encounter scaling in section 8 assumes this). Invite by name, right-click, or from the friends list; the leader can kick and pass leadership; leaving is instant.
- Party members show on the compass and map at any distance, with health bars in a party frame (positions arrive in the zone snapshot's party ring).
- Fast travel to a party member's last waypoint. Personal loot means no loot rules to configure.
- Party state lives in Redis and survives a member's reconnect for 5 minutes.

**Friends and presence.** Send and accept requests, up to 200 friends. The list shows online status and current region, with buttons to whisper, invite to party and travel. Presence is stored in Redis with a heartbeat; dead sessions are reaped the way the-circle's `room_state.py` does.

**Proximity voice**

Voice runs through a self-hosted LiveKit SFU, not a mesh: each player uploads one audio stream, the SFU forwards it only to the people who should hear it, and nobody's IP is exposed to strangers.

1. **Who hears whom is decided by the server.** Every 250 ms the zone server computes each player's earshot set: players within 40 m in open air or 30 m in the same cave system, capped at the 12 nearest, with hysteresis (join at 40 m, leave at 48 m) so subscriptions don't flap. It sends the sets to the social service, which applies them through LiveKit's server API with auto-subscribe off. This is the-circle's declarative reconcile idea in `rtc.ts`, applied to subscriptions instead of peer links.
2. **Party members are always in your set,** at any distance. Within earshot they sound spatial like anyone else; beyond it they play flat through a light radio filter. One published track covers both cases.
3. **The client spatializes.** Per speaker: gain (per-player volume and mute), then a `PannerNode` with HRTF at their interpolated head position each frame (inverse distance, reference 2 m, max 40 m), then the cave reverb send when underground. A wasm raycast at 4 Hz per speaker adds a low-pass filter when terrain is between you.
4. **Speaking indicators** use the-circle's `audio.ts` approach: one AudioContext, an analyser per track, levels written straight to the DOM and to the nameplate outside React. The speaking bit also rides in the zone protocol's activity flags so far players' silhouettes can show it.
5. **Defaults that keep strangers safe:** push-to-talk on V by default, voice activation as an opt-in setting, microphone not requested until the first push. Per-player mute and volume. Local-profile players can hear voice but not transmit, and can't use global chat.
6. **Scale:** start with one LiveKit room per world. If participant-update fan-out becomes the bottleneck in the soak test, shard rooms by region and accept a brief reconnect on handoff. Record the measurement and the decision in `docs/decisions/`.
7. **TURN:** use LiveKit's built-in TURN; for any separate TURN, reuse the time-limited HMAC credential pattern from the-circle's `ice.py`.

**Moderation**

- Token-bucket rate limits per channel (ported from the-circle). Global has slow mode: one message per 10 s per player.
- Message length 280 characters. A profanity filter is on by default for global and zone, and can be turned off per player for themselves.
- Report a player from their nameplate or a message: captures the last 50 messages of context from that channel or whisper conversation into Postgres. Voice is never recorded.
- Mute (stop hearing or reading someone in all channels) and block (mute plus no whispers, no party invites, no voice both ways).
- Admin CLI: mute, suspend and ban accounts, read reports. No admin UI in v1.

## 11. Persistence and data model

Postgres holds anything a player would be upset to lose; Redis holds anything that is fine to rebuild after a restart. Migrations live in `contracts/migrations/` (plain SQL, numbered, applied by a small Go migrator) because several services read the same tables.

**Postgres tables (v1)**

| Table | Key columns | Notes |
| --- | --- | --- |
| `accounts` | `id`, `auth_provider`, `auth_subject`, `created_at`, `status` | OAuth via Firebase Auth (Google first, Discord and GitHub later); local profiles have no row |
| `worlds` | `id`, `name`, `seed`, `spec` (jsonb), `gen_version`, `atlas_hash` | One row is one world |
| `characters` | `id`, `account_id`, `world_id`, `name` (unique per world), `level`, `xp`, `position`, `last_waypoint`, `stamina_max`, `appearance` (jsonb) | Saved every 30 s, on zone transfer and on logout |
| `character_progress` | `character_id`, `towers` (bitset), `waypoints` (bitset), `containers_opened` (bitset), `discoveries` (bitset), `skill_tree` (jsonb), `spells_known`, `spells_equipped` | Bitsets indexed by atlas POI and container ids |
| `items` | `id`, `owner_character_id`, `kind`, `base_id`, `item_level`, `rarity`, `affixes` (jsonb), `sockets` (jsonb), `slot`, `roll_seed`, `created_at` | Every roll stores its seed for audit |
| `world_edits` | `world_id`, `chunk_x`, `chunk_z`, `edit_id`, `kind`, `target_id`, `params` (jsonb), `tick`, `expires_at` | Append-only; a sweeper deletes expired rows hourly |
| `friends` | `account_a`, `account_b`, `state` | Requests and accepted pairs |
| `blocks` | `blocker`, `blocked` |  |
| `reports` | `id`, `reporter`, `reported`, `channel`, `context` (jsonb), `created_at`, `resolution` |  |

**Redis keys (v1)**

| Key | Holds |
| --- | --- |
| `presence:{characterId}` | Online, zone, region, last heartbeat (TTL 30 s) |
| `name:{worldId}:{lowercaseName}` | Character id, for whisper and invite lookups |
| `party:{partyId}` | Members, leader, created |
| `chat:{worldId}:{channel}` | Capped list of recent messages |
| `zones:{worldId}` | Zone server registry: endpoint, owned regions, load |
| `worldpos:{worldId}` | Every player's position at 1 Hz for the far ring across zones |
| Pub/sub `social:{worldId}`, `zone:{zoneId}` | Cross-service events: earshot sets, party updates, whisper delivery |

**Rules**

- Loot grants are a single transaction: insert items and mark the container or vein for that character together. A crash can lose a roll but never duplicate one.
- Zone servers never block a tick on Postgres. Writes go through a per-zone write-behind queue with retry; reads happen on login and zone transfer.
- Character state on the wire is authoritative only in the owning zone server's memory; Postgres is the checkpoint.

**Two ways to keep a character: an account, or a local profile**

Players choose on the first screen. Both play in the same shared world; the difference is where the character's save lives.

|  | OAuth account | Local profile |
| --- | --- | --- |
| Sign-in | Google via Firebase Auth (more providers later) | None; a random profile id is created in the browser |
| Where the save lives | Postgres | The browser's IndexedDB, as a signed save blob |
| Survives clearing browser data | Yes | No, unless exported; an Export and Import button saves the blob to a file |
| Plays on other devices | Yes | Only by importing the exported file |
| Social | Everything | Local and party chat, whispers to friends and party, listen-only voice |
| Future trading | Yes | No; upgrade to an account first |

**Why a local save can't be tampered with.** The game stays server-authoritative either way. At each save point the zone server builds the character's state (level, skills, inventory, progress), signs it with the server's Ed25519 key together with the profile id and a counter, and sends it to the client to store. On connect, the client presents its latest blob; the server checks the signature and that the counter is the newest it issued (a tiny `localsave:{profileId}` record in Redis, kept 180 days). Edited blobs fail the signature; old blobs fail the counter, so rolling back to duplicate an item doesn't work.

Use IndexedDB, not localStorage: saves can reach hundreds of kilobytes and localStorage is small and blocks the main thread. The same IndexedDB also caches the atlas, wasm and built chunks (section 12), under separate stores so clearing caches never deletes a save.

**Upgrading** a local profile to an account imports its latest verified blob into Postgres in one transaction, after which the browser copy is only a cache.

## 12. Rendering, textures and performance budgets

The client keeps 60 fps by doing generation and meshing in workers, rendering the world imperatively rather than as one React component per chunk, and spending visual budget on what matters for exploration: draw distance, light and the glow of gems.

**Structure**

- React Three Fiber owns the scene root, camera, post-processing and UI overlays. The world (terrain, caves, scatter, water) is a plain Three.js chunk manager with its own update loop, because React reconciliation per chunk is too slow at this scale.
- Generation workers: `min(navigator.hardwareConcurrency - 2, 4)`. Each runs `worldgen.wasm`, builds vertex buffers and transfers them to the main thread. GPU uploads are throttled to a few chunks per frame so traversal never hitches.
- WebGL2 is the baseline. A WebGPU renderer is a later option behind a flag, not a v1 requirement.

**PBR textures: same source and pipeline as Nicole's 3D projects**

- Source: the free CC0 SD texture sets from [3dtextures.me](https://3dtextures.me), as used by 3d-portfolio-website and wizard-wars. Raw sets live in `texture-sources/<Set>_SD/` outside `public/`, so they never ship.
- Build: port 3d-portfolio-website's `scripts/build-textures.mjs` to `tools/textures/build-textures.mjs`. It already packs each set into `color.webp` (sRGB albedo), `normal.webp` (OpenGL convention) and `orm.webp` (R ambient occlusion, G roughness, B metalness), with per-set size and brightness gain.
- Load: copy wizard-wars' `client/src/utils/pbrMaterial.ts` and keep its rules: textures and materials cached per id, a flat fallback color until all maps arrive together, tiling baked into UVs in world meters, cached resources never disposed on unmount, normal maps skipped on the low quality tier.
- New for terrain: the build script also emits **texture arrays** per map type (color, normal, ORM) at 512 x 512 with mips, compressed to KTX2, one layer per terrain material. The terrain shader blends up to 6 layers by the generator's splat weights, and uses triplanar sampling for the rock layer on slopes above 50 degrees so cliffs don't stretch.
- Starting set list (pick matching 3dtextures.me sets): meadow grass, forest floor, dirt, highland rock, cliff rock, snow, sand, mud, cave rock, cave wet rock, crystal, ruins stone (reuse `marble-white` and `stone-column`).
- Keep a `CREDITS.md` listing every set, even though CC0 does not require it.

**World look**

- Terrain: clipmap or quadtree LOD with geomorphing so LOD changes don't pop; distant terrain uses the atlas heightmap directly.
- Scatter: `InstancedMesh` per object type per chunk group, three mesh LODs for trees, billboards beyond 200 m, fade-in at the far edge.
- Sky: analytic atmospheric scattering driven by world time, height fog for distance, stars at night.
- Shadows: sun only, cascaded, 2 cascades on medium and 3 on high, none on low.
- Water: planar with depth fade and gentle normal motion; no screen-space reflections.
- Post: bloom (for gems, spells and sun) and color grading, using the post-processing setup from wizard-wars.
- Spell FX: wizard-wars' FX layer and recipes, with shader warmup at load.
- First person: wizard-wars' `ArmAndWand` and `LocalPlayerModel` for your own view; remote players get a third-person model with 3 LODs and a nameplate.

**The Valheim bar: light first**

Valheim's beauty comes mostly from light and atmosphere on modest geometry, which is exactly what a browser can afford. Spend the budget there.

- **Sun shafts through trees:** screen-space god rays (radial blur from the sun's position, masked by depth) at half resolution, plus height fog with sun in-scattering so rays show in the air. Leaves are alpha-tested in the shadow map so light dapples the ground.
- **One wind field** drives grass, leaves, banners, smoke, fire spread and glide updrafts, so everything sways together and agrees with the chemistry.
- **Clouds that cast moving shadows,** weather particles, wet materials in rain (lower roughness, darker albedo), snow that settles on upward-facing surfaces in a shader.
- **Soft ambient light:** sky-derived ambient plus screen-space ambient occlusion at half resolution on the high tier.
- **Grading per biome and time of day** with color lookup tables, filmic tone mapping, bloom for gems, spells and the sun.
- **Small living touches:** flickering torch and campfire lights, fireflies at dusk, birds scattering, dust motes in sun shafts, ambient soundscapes per biome (3d-portfolio-website's `roomSoundscape.ts` approach).
- Every effect has a quality tier switch and stays inside the frame budget below.

**Precompute, preload and cache**

The rule: never compute at runtime what can be computed once, and never compute twice what can be cached.

| When | What | Effect |
| --- | --- | --- |
| At asset build | KTX2 (Basis Universal) compressed textures for terrain arrays, foliage and building atlases; mesh LODs; octahedral impostors for every tree and large rock; the list of shader variants | GPU memory roughly a quarter of WebP-decoded textures; distant trees cost a quad each |
| At world mint (server, once) | Atlas, roads, towns, structure placements, nav grids, POIs, plus low-resolution horizon tiles per region (mesh with baked color and normals) | Distant mountains render from a few cheap tiles; nothing world-scale is computed on a player's machine |
| At load | Content-hashed atlas, wasm and horizon tiles from the CDN, cached forever in IndexedDB; shader precompile during the loading screen using `KHR_parallel_shader_compile` (wizard-wars' `ShaderWarmup` idea) | Second launch skips downloads; no first-use shader hitches |
| While playing | Predictive streaming: generate chunks ahead along your velocity and view direction, farther ahead when gliding or sprinting; idle worker time pre-builds the next ring | Terrain is ready before you arrive |
| While playing | Built chunk meshes cached in IndexedDB by `(genVersion, chunk, lod)` with an LRU cap of 500 MB | Revisiting an area loads instantly |
| Every frame | Object pools for projectiles, FX and pickups (as in wizard-wars), time-sliced GPU uploads, far shadow cascades updated every few frames, god rays and SSAO at half resolution, dynamic resolution when frame time runs over | Steady frame time instead of spikes |

On the server, the same idea: nav grids, structure collision and enemy spawn tables are built at mint, and chunk collision is cached by interest so walking players never wait on generation.

**Budgets (acceptance criteria, measured in a headless traversal benchmark)**

| Measure | Budget |
| --- | --- |
| Frame time, 1080p, high tier, M1 MacBook Air or RTX 3070 class | 16.6 ms (60 fps) |
| Frame time, 720p, low tier, integrated GPU | 33 ms (30 fps) |
| Draw calls per frame | 400 or fewer |
| Visible triangles | 1.5 million or fewer |
| GPU memory | 1 GB or less |
| JS heap | 600 MB or less |
| Download before first playable frame, gzipped | 15 MB or less |
| Time to playable on a 50 Mbps connection | 8 s or less |
| Main-thread long tasks during traversal | None over 50 ms |
| Detail chunk generation in a worker | 8 ms or less |

## 13. Infrastructure and deployment

Stateless HTTP pieces can stay on Cloud Run and Netlify like Nicole's other projects; the zone servers and voice cannot, because they hold long-lived state and need UDP. Start small: one VM runs every stateful piece.

| Piece | Where (v1) | Why |
| --- | --- | --- |
| Client and creator tool | Netlify | Static builds; matches existing projects |
| Director, account service | Cloud Run | Stateless HTTPS |
| Zone servers, social service | One small GCE VM running containers, started on demand | Long-lived connections, in-memory state, QUIC over UDP; Cloud Run ends WebSockets at its request timeout and does not accept inbound UDP |
| LiveKit | Same VM at first, its own VM when voice load grows | Needs a UDP port range and a public IP |
| Postgres | Postgres in a container on the VM, nightly dumps to Cloud Storage | No always-on database bill; move to managed Postgres only when load requires |
| Redis | On the VM to start, Memorystore later | Ephemeral data only |
| WorldSpec LLM call | Inside the creator tool's endpoint on Cloud Run | Feature-flagged, API key in Secret Manager |

**Rules**

- Everything deploys from scripts in `infra/` that an agent can run end to end with the authenticated `gcloud` and Netlify CLIs. No manual console steps; if one is unavoidable, the script prints exactly what to click.
- A GitHub Actions workflow builds, tests (including the determinism golden tests) and deploys on merge to `main`, modeled on wizard-wars' `.github/workflows/deploy.yml`.
- `worldgen.wasm` is published with its content hash in the filename and kept forever, so pinned worlds can always load their generator.
- Observability from day one: each Go service exports Prometheus metrics (tick time, players, bytes in and out per client, AOI set sizes, write-behind queue depth) and structured logs. The client debug HUD shows fps, transport, RTT, bandwidth and chunk queue, extending wizard-wars' `FrameStats` and `NetworkStats`.
- Moving to more VMs, or to Agones on GKE for zone fleet management, is a later decision driven by the soak numbers, not a v1 task.

**Keeping it cheap at every size**

The target is near-zero cost when nobody is playing, and cost that grows with players rather than with time.

1. **Scale to zero where possible.** Netlify for static files; Cloud Run with zero minimum instances for the director, account service and creator endpoint.
2. **Wake the world on demand.** The director starts the game VM when the first player signs in and stops it after 15 minutes with nobody online. The client shows a short "waking the world" screen during the cold start. Postgres runs on the same VM, so there is no separate always-on database.
3. **Grow with spot capacity.** Extra zone servers for busy regions run on spot (preemptible) VMs. If one is reclaimed, its regions fail over to the primary zone server from the last checkpoint and players reconnect automatically. The primary VM stays on regular pricing.
4. **Bandwidth is the real cost,** so the budgets in sections 9 and 12 are also cost controls. Immutable, content-hashed assets (wasm, atlas, horizon tiles, textures) are served from the CDN and cached forever, so each player downloads them once. Voice egress is bounded by the 12-speaker earshot cap.
5. **Portable by design.** Every service ships as a container configured by environment variables, with no provider-specific SDK in game code. Moving to a cheaper host is a config change, not a rewrite.
6. **Know the number.** A small dashboard tracks monthly cost divided by peak concurrent players, and WP19 records it in `docs/decisions/v1-capacity.md`.

## 14. Testing and tooling

The three reference repos already have good harnesses (netsim proxy, netem profiles, soak scripts, headless playtests). Port them first, then build on them; a work package is not done until its slice runs under them.

| Harness | What it proves | Based on |
| --- | --- | --- |
| Determinism golden tests | Same chunk, cave and atlas hashes in Node, headless Chromium and Go/wazero | New; runs in CI on every PR touching `worldgen/` |
| Protocol golden vectors | TS and Go codecs produce and read identical bytes | New; generated alongside the codecs |
| Headless bots (`tools/bots/`, Go) | Hundreds of players walking, climbing, gliding, casting, chatting, joining parties | wizard-wars `BotAI.js` and `scripts/playtest/soak.mjs` |
| Netsim proxy | Gameplay under latency, jitter and loss | wizard-wars `scripts/playtest/netsim-proxy.mjs` |
| netem profiles | Real packet impairment ("thailand": about 160 ms RTT, 3% loss; "mobile": 1.5 Mbit, 6% loss) | the-circle `e2e/netem.sh` |
| Voice soak | 50 fake clients with fake microphone audio moving around; earshot sets and subscriptions stay correct | the-circle `e2e/soak.mjs` (fake media devices) |
| Traversal benchmark | Headless browser flies a fixed path across biomes and into a cave; records frame times, long tasks, memory | 3d-portfolio-website puppeteer scripts |
| Visual snapshots | Fixed camera spots render the same, for catching generator or shader regressions | Puppeteer screenshots compared with a tolerance |

**Required soak scenarios before v1 is called done**

1. 300 bots in one region plus 2,000 awake enemies: zone tick p99 within budget, no client over the downlink budget.
2. 1,000 bots across the world with continuous zone crossings: no dropped players, no duplicated items.
3. 50 voice bots clustered and dispersing: subscriptions follow earshot within 500 ms, no flapping.
4. All of the above under the "thailand" netem profile.

**Developer tools in the client** (hidden behind a debug flag): teleport to coordinates, toggle fly, freeze time, show chunk and cell borders, show AOI rings, show cave graph, show earshot set, regenerate the current chunk and compare its hash.

## 15. Work packages

Twenty-one packages in six phases. Packages in the same phase can run in parallel (one Sonnet agent each, in separate git worktrees, at most four at once). A phase starts only when its gate passes; an Opus review (or Nicole) checks each gate against the evidence in the merged PRs.

(Roadmap, in prose: Phase 0 = WP00 → gate G0. Phase 1 = WP01–WP04 → G1. Phase 2 = WP05–WP08 → G2. Phase 3 = WP09–WP12 and WP20 → G3. Phase 4 = WP13–WP15 → G4. Phase 5 = WP16, WP18, WP19 → G5. WP17 Creator needs only the worldgen core and can start any time after G1.)

| Gate | Passes when |
| --- | --- |
| G0 | Repo builds, contracts generate, `npm run dev` brings up empty services |
| G1 | Same chunk hashes in Node, Chromium and Go; one player walks generated terrain solo |
| G2 | Two browsers see each other on generated terrain over the binary protocol; 150 bots soak within budget; chat and whispers work |
| G3 | Two friends explore a cave together with proximity voice, climb and glide, use the map and towers |
| G4 | Full loop: fight, loot, mine ore and a gem, forge a sunsteel blade, socket the gem, survive a night in a generated town |
| G5 | All four soak scenarios in section 14 pass; deployed |

### Phase 0

**WP00: Monorepo scaffold and contracts.** Depends on nothing. Owns the repo root, `contracts/`, `infra/docker-compose.yml`, `docs/`.

- Create the layout in section 4, workspaces for npm, Go and Cargo, lint and typecheck configs, and the CI workflow skeleton.
- `contracts/protocol.yaml` with the handshake, input, snapshot (with field masks), event and edit messages from section 9; the codegen that emits TS and Go plus golden vectors.
- `contracts/constants.yaml` with movement, AOI and chat constants, generated to TS, Go and Rust.
- `contracts/worldspec.schema.json` (section 6) and the first migration (section 11).
- Docker compose for Postgres, Redis and LiveKit; `npm run dev` and `npm run dev:solo` scripts; `refs/` clone script.
- Accept: G0, plus codec golden tests pass in both languages.

### Phase 1 (parallel)

**WP01: Worldgen core, overworld.** Depends on WP00. Owns `worldgen/`. Reads sections 5 and 6.

- Rust crate with `spec_from_seed`, atlas pass (macro height, hydrology, climate, biomes, POI placement by visibility), chunk detail pass (heights, splats, scatter with stable ids, container and spawn anchors), collision queries, hashing.
- Determinism harness for Node, Chromium (headless) and Go/wazero; 200-chunk golden table.
- A small debug page that renders the atlas as a 2D map with POIs, for eyeballing.
- Accept: golden tests pass on all three hosts; detail chunk under 8 ms in a browser worker; atlas under 2 MB gzipped.

**WP02: Client shell and movement.** Depends on WP00. Owns `client/` (shell, input, camera, stores, HUD, debug tools).

- Vite, React, R3F app; port wizard-wars movement, camera, input hooks, quality store, frame stats; first-person arms.
- Runs on a flat placeholder terrain with a pluggable ground-query interface that WP05 replaces.
- Accept: walk, sprint, double jump feel identical to wizard-wars (side-by-side capture); debug HUD shows fps.

**WP03: Zone server skeleton.** Depends on WP00. Owns `server/zone/`, `server/pkg/` (except generated code).

- Go process: 30 Hz scheduler (port of wizard-wars' reasoning), WebSocket transport first with the WebTransport interface stubbed, session handshake with ticket check, entity store, 32 m cell grid, AOI rings, delta snapshots, write-behind queue.
- Bot client in `tools/bots/` that connects and walks.
- Accept: 150 bots on flat ground, tick p99 under 5 ms, per-client downlink within budget.

**WP04: Accounts, director and persistence.** Depends on WP00. Owns `server/account/`, `server/director/`, migrations after the first.

- Firebase Auth OAuth sign-in; local profiles with signed IndexedDB save blobs, export, import and upgrade (section 11); character create and list; world list; Ed25519 connect tickets; zone registry in Redis.
- Accept: a browser signs in, creates a character, receives a valid ticket that WP03 accepts.

### Phase 2 (parallel)

**WP05: Chunk streaming, terrain rendering and textures.** Depends on WP01, WP02. Owns `client/src/world/`, `tools/textures/`, `texture-sources/`.

- Worker pool, atlas download and IndexedDB cache, chunk manager with LOD and geomorphing, splat shader with texture arrays and triplanar cliffs, instanced scatter, sky, fog, sun shafts, the shared wind field, water, shadows, and the precompute, preload and cache work from section 12.
- Port `build-textures.mjs` and `pbrMaterial.ts` as described in section 12; choose and add the starting texture sets from 3dtextures.me.
- Accept: traversal benchmark meets section 12 budgets on the high and low tiers; no visible LOD pops at walking speed.

**WP06: Netcode integration.** Depends on WP02, WP03, WP04. Owns `client/src/net/`, snapshot handling in `server/zone/`.

- Port ClientPrediction, EntityInterpolation and ClockSync onto the binary protocol; remote player models and nameplates; WebTransport with WebSocket fallback; per-ring interpolation.
- Accept: G2's two-browser test on flat ground under the "thailand" profile with no visible rubber-banding at walking speed.

**WP07: Server terrain and collision.** Depends on WP01, WP03. Owns `server/pkg/worldhost/`.

- wazero host for `worldgen.wasm`, chunk cache by interest, collision queries for movement validation, ground snapping.
- Accept: bots walk generated terrain on the server; server and client ground heights match exactly at 10,000 random points.

**WP08: Social service.** Depends on WP04. Owns `server/social/`, `client/src/social/`.

- WebSocket service; channels (global, zone, local with bubbles, party, whisper, system); whisper tabs, `/w` and `/r`, name autocomplete; parties; friends; presence; mute, block, report; rate limits and slow mode; admin CLI.
- Accept: chat in every channel and whispers between two zones work in a two-browser test; blocked players' whispers are dropped; rate limits hold under a bot flood.

### Phase 3 (parallel)

**WP09: Caves, gems and mining.** Depends on WP05, WP07. Owns cave code in `worldgen/`, `client/src/world/caves/`.

- Cave graph, density rasterization, surface-nets mesher in wasm, mouth masks and rock arches, cave lighting and reverb bus, ore veins and gem pickups, mining edits with respawn.
- Accept: golden tests extended to caves; walk from a mouth to the deepest chamber of a generated system; mined veins and carves restore on schedule.

**WP10: Movement extensions.** Depends on WP06, WP07. Owns movement code in client and zone.

- Climb, glide, swim, stamina wheel, rain slip; server validation for each mode; activity flags.
- Accept: climb a cliff, glide from a tower top, swim a lake, all matching between client prediction and server within 10 cm.

**WP11: Proximity voice.** Depends on WP06, WP08. Owns `server/social/voice/`, `client/src/voice/`.

- LiveKit integration; earshot computation in the zone server; subscription reconcile in the social service; spatial audio graph; occlusion low-pass; party radio; speaking indicators from the-circle's `audio.ts`; push-to-talk.
- Accept: voice soak scenario 3 passes; two people walking apart hear each other fade and pan correctly.

**WP12: Towers, waypoints and the map.** Depends on WP05, WP06. Owns `client/src/ui/map/`, POI logic in zone.

- Tower climbing reveals the region map; waypoints and fast travel; compass; personal and party pins; discovery XP.
- Accept: G3's map and tower flow works for two players in a party.

**WP20: Towns, roads and structures.** Depends on WP05, WP07. Owns settlement and structure code in `worldgen/`, `client/src/world/buildings/`, NPC code in zone.

- Settlement siting, roads and bridges, town layouts, per-biome building kits and the shape grammar, interiors, the jigsaw structure library (v1 set in section 5), NPC schedules, merchants, blacksmith, inn and bounty board.
- Accept: golden tests extended to towns and structures; every region has a settlement; a full v1 world's settlements and structures generate in under 60 s; a whole town renders within the draw-call budget.

### Phase 4

**WP13: Combat, weapons, magic and enemies.** Depends on WP10. Owns combat, weapon, spell and enemy code in client and zone.

- The combat feel targets in section 8, measured with an input-to-hit timing probe in the client.
- Weapons: sword, spear, bow (with ore arrows and gem tips), staff and wand; two loadouts; use-based skills with technique unlocks; elemental forms.
- Magic: port Fire, Ice, Dark and Earth from wizard-wars (Sword becomes a weapon skill); build Lightning, Wind, Light and Void trees, with spell names proposed in the PR for Nicole's approval.
- PvE-only targeting; lenient hit validation; enemy tables per biome, depth and element; elites; bosses with phases in generated arenas; party scaling.
- Accept: every combat feel target met; a party of two clears a camp and a cave boss; no attack or spell can damage a player.

**WP14: Loot, rarities, forging and drops.** Depends on WP13, WP09, WP04. Owns item code in zone, `client/src/ui/inventory/`.

- The eight rarity tiers with their colors, odds and announcement for Bitchin'; personal loot; affixes; sockets; gem cuts; ores, smelting, blueprints and forging at town forges; consumables and cooking.
- Dropping and picking up items through `TransferItem`; `tradeable` and `provenance` on every item; unverified marking for local-profile drops.
- Accept: G4 loop works; killing the zone server mid-grant never duplicates an item; a dropped item can be picked up by another player and despawns after 10 minutes.

**WP15: Night, demons, weather and chemistry.** Depends on WP13, WP20. Owns `client/src/systems/`, night and chemistry code in zone.

- Day and night with the moon cycle; demon spawning, regeneration and the sunsteel, Light and sunrise rules; demon ranks and lords; ward gardens and town defense events.
- Material grid, fire spread on the shared wind field with updrafts, freezing, pillars, rain; event sync with the bitmap fallback behind one interface.
- Accept: a demon survives ordinary damage and dies to sunsteel; a town defense event runs start to finish with two players; two clients see the same fire spread cell for cell for 60 s.

### Phase 5

**WP16: Multiple zones and handoff.** Depends on WP06, WP07. Owns zone assignment and handoff code.

- Region ownership, ghost bands, pre-connect and transfer, world presence feed for far ring.
- Accept: soak scenario 2 passes.

**WP17: WorldSpec creator tool.** Depends on WP01 only, so it can run any time after G1. Owns `tools/creator/`.

- Presets, sliders with live atlas preview, mint flow, optional LLM vibe path behind a flag with validation, clamping and caching as in section 6.
- Accept: mint a world from seed only, from sliders, and (flag on) from vibe text; with the flag off, no code path calls a model.

**WP18: Deploy and observability.** Depends on all service packages. Owns `infra/`, CI deploy.

- Scripts and workflow from section 13; metrics and dashboards; content-hashed wasm publishing.
- Accept: a clean clone deploys everything with one script; metrics visible.

**WP19: Scale and performance hardening.** Depends on everything. Owns nothing new; fixes go to the owning package's paths with a note in its README.

- Run every soak scenario and benchmark; profile; fix; record results in `docs/decisions/v1-capacity.md`.
- Accept: G5.

## 16. Open questions for Nicole

Agents proceed with the default in brackets until these are answered.

- [ ] **Name.** "Lodestone" is a placeholder. [Keep it in code as the package prefix; rename is a find-and-replace.]
- [ ] **Worldgen language.** Rust gives small, deterministic wasm, but it is the one language in the stack you don't use daily. TinyGo is the alternative, with bigger binaries and less mature wasm tooling. [Rust.]
- [ ] **Party size.** [4.] Going to 6 or 8 changes enemy scaling and the party frame.
- [ ] **Art direction.** The 3dtextures.me PBR sets push toward grounded, semi-realistic surfaces; Breath of the Wild is painterly. [PBR surfaces with a stylized grade and soft lighting; revisit after WP05's first screenshots.]
- [ ] **Voice default.** [Push-to-talk.] Voice activation feels more alive but is riskier with strangers.
- [ ] **Local profiles.** [Decided: replaced by local profiles, which get local and party chat, whispers to friends and party, and listen-only voice (section 11).]
- [ ] **How many worlds.** [One official world for v1, more minted with the creator tool when it fills.]
- [ ] **Any player-vs-player at all.** [None. A friendly sparring mode could come later as its own design.]
- [ ] **Compressed GPU textures (KTX2 / Basis).** Decided: KTX2 for terrain, foliage and building atlases in v1, WebP elsewhere (section 12).
- [ ] **New spell names.** Agents will need some for PvE-specific spells and gem effects. [Agents propose names in the PR; you approve before merge, following the Wizard Wars naming philosophy.]
- [ ] **Solo vs party framing.** [Read as: fully playable solo, parties optional, still no PvP.]
- [ ] **Player building.** Modded Minecraft lives on building. [Not in v1; a later design could add claimable plots in towns.]
- [ ] **Weapon roster.** [Sword, spear, bow, staff and wand in v1.] Daggers, greatswords, hammers or a whip later?
- [ ] **Rarity colors.** [Grey, green, blue, purple, orange, red, white-gold, animated holographic.]
- [ ] **How hard nights are by default.** [`demonIntensity` 0.5: a lone player can survive in the open with sunsteel, but most will head for a town.]

## 17. Glossary

| Term | Meaning here |
| --- | --- |
| Authoritative server | The server's copy of the game is the real one. Clients predict for responsiveness, but the server decides what actually happened: hits, loot, positions. |
| Tick, tick rate | One step of the server simulation. 30 Hz means 30 steps a second, one every 33 ms. Clients still render at 60 fps or more and smooth between ticks. |
| Client prediction | Your browser applies your own inputs immediately instead of waiting for the server, then corrects if the server disagrees. |
| Interpolation | Showing other players slightly in the past (about 100 ms) so their motion is smooth between server updates. |
| AOI (area of interest) | The bubble of the world a player receives updates about. Full detail nearby, less often farther out, nothing beyond about 600 m. |
| Zone server | One server process that simulates a set of regions. The world is split across several so no process simulates everything; players hand off between them without loading screens. |
| Ghost band | The 64 m strip along a region border that is mirrored to the neighboring zone so players can see across it. |
| WS (WebSocket) | A long-lived browser connection over TCP. Reliable and ordered, so one lost packet delays everything behind it. |
| WebTransport | A newer browser API over HTTP/3 (QUIC) that supports unreliable datagrams, so a lost position update is simply replaced by the next one. |
| SFU (selective forwarding unit) | A voice server that receives each person's audio once and forwards it only to those who should hear it. Each player uploads once, and no one's IP is exposed. |
| LiveKit | An open source SFU written in Go, self-hosted, that lets our server decide who hears whom. |
| Mesh | Everyone connects directly to everyone (the-circle's model). Fine for 8 people, too costly and exposing for proximity voice. |
| TURN | A relay server for WebRTC when two endpoints can't connect directly. |
| WebAssembly (wasm) | A portable binary format browsers and other hosts run at near-native speed. Its standard arithmetic gives identical results on every machine, which is why worldgen uses it. |
| wazero | A WebAssembly runtime for Go, so zone servers run the same `worldgen.wasm` as browsers. |
| SIMD | Single instruction, multiple data: one CPU instruction doing the same math on several numbers at once. Standard wasm SIMD is deterministic; "relaxed SIMD" can differ by CPU, so worldgen bans it. |
| Determinism | Same inputs always give the same bits out, on every machine. |
| Golden test | A stored table of expected output hashes that CI checks the generator against. |
| genVersion | The generator version a world is pinned to, identified by its wasm file's hash. |
| Atlas | A world's precomputed plan: macro terrain, rivers, biomes, towns, roads, structures and POIs. Built once at mint. |
| Chunk, region | 64 m and 1024 m squares of the world. |
| POI | Point of interest: a town, tower, cave mouth, structure, camp or landmark. |
| Delta snapshot | A server update containing only what changed since the last update the client acknowledged. |
| Hitstop | A tiny freeze on a successful hit that makes it feel weighty; local only. |
| KTX2 / Basis | Compressed GPU texture formats that stay compressed in GPU memory. |
| Impostor | A pre-rendered picture of a tree or rock drawn on a flat card at distance. |
| Spot VM | Discounted cloud capacity the provider can reclaim at short notice. |
