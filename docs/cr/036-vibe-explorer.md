# CR 036: Vibe explorer (playtest 2)

Branch `pt2/vibe-explorer`. Nicole, who composes the game's music: "i wanna build a local dev thing where I can teleport to a new chunk with specified params like what is in that chunk like landmarks, what level it is, and the biome. I want to assess vibe and difficulty. also let me change my level too. this will be used to compose new music."

## Summary

A **Vibe** tab in the F2 dev console (CR 032) and `/vibe`, `/music` commands. Same gate as the console: the zone takes the commands only with `LODESTONE_ZONE_DEV=1` and the development ticket key (Event 1401 value 1 and no effect otherwise), the client shows the console only in a debug build on such a zone.

- **Find and teleport** (zone, exact): an index of every place the world has, built once from the atlas (every settlement by size, crystal tower, wilderness waypoint, cave mouth, natural landmark by variant, enemy camp, structure by kind, vault, the Heartfall), the macro terrain (per 256 m area at most one peak, one lake shore, one river bank, one coast), live world events, and one "wilds" spot per dry area (617 on the official world). Filters: biome, landmark (35 keys), region, area level range and tier (stamped areas by their level; unstamped ones by what the asking player would stamp them at now, `difficulty.Map.Projected`), stamped or not, distance from the spawn. Matches are sorted by distance from the spawn (then kind, name, x), so the same query always lists the same places; each comes with "what's there" (up to 4 places within 250 m). Teleports land on the nearest safe spot within 120 m (inside the world, dry, a walkable slope with level room around, outside every building footprint with 1.5 m margin, clear of town boxes and camp pieces) with 5 s of invulnerability. "Random match" picks a match server-side; "next"/"prev"/"#n" walk the list.
- **Set the vibe**: an area's level as a dev override (`difficulty/dev.go`: on top of the stamp, never stored, cleared back to exactly what was there, logged; its atlas groups respawn at once at the new level and tier: `combat.World.DevRespawnArea`), the area's typical enemies (its biome's camp table, its region element, the tier's beginner share: `combat.World.DevTypical`), freeze the vibe (time held, the weather where you stand forced, every group's AI stopped like a training dummy; restored on unfreeze), night demons off/on; your level, time, weather and world events are the console's existing commands, also on the tab.
- **Composer aids** (client, `client/src/audio/composer/`): now playing (director state, track, position, source: game / forced / mapped; why: the director's reason, biome, time of day, weather, area tier and level, story act, intensity; every ambience layer and positional loop with its level; each bus's volume, duck and solo/mute; the output level), override (force a state at once, a built-in or loaded track, an intensity; loop a section of a forced track), solo/mute buses, a pinned now-playing box over the game, **your own audio files** (WAV/MP3/OGG/FLAC/M4A, decoded in the browser, kept in IndexedDB, played through the music bus with the same ducking and a crossfade with the game's music) and **mappings** (a loaded file plays when the vibe matches; localStorage; JSON export/import). Format and wiring: `client/src/audio/README.md` "Composer mappings".

## Contract changes

- **Interact 250** actions 29-35 (contracts/events.md): 29 find, 30 go (safe landing), 31 area level override, 32 typical enemies, 33 freeze the vibe, 34 demons, 35 here.
- **Events** 1403 `dev_vibe` (search results), 1404 `dev_vibe_here` (where you stand and the vibe state); 1405-1419 stay reserved.
- No protocol, YAML, constants or migration change. The filter's bit layout is `game.VibeFilter.Pack` = `filters.ts packVibe` (one vector in both test suites); the landmark and biome lists are positional and shared (`vibe_test.go` reads `filters.ts`).

## Server

`server/zone/internal/game/vibe.go` (new) behind `devApply`; `internal/difficulty/dev.go` (override, `Projected`, `Square`; `Map.Level` and `Map.Haven` honour an override: one line each); `internal/combat/vibe.go` (respawn an area, typical enemies, freeze, the macro grid); `combat.ParseAtlas` keeps the atlas HEIGHT and WATER sections (terrain features come from the macro grid, never from chunks, so a search generates nothing). Landing invulnerability rides `Player.DevGod`, cleared by `devTick` when it runs out (unless god mode is on).

## Client

`client/src/ui/devconsole/vibe/` (new: `filters.ts`, `store.ts`, `commands.ts`, `runMusic.ts`, `VibeTab.tsx`, lazy-loaded with the composer), `client/src/audio/composer/` (new: `override.ts`, `mapping.ts`, `composer.ts`, `files.ts`, `hook.ts`). Shared files, small: `ui/devconsole/{DevConsole.tsx, commands.ts, store.ts}`, `audio/engine.ts` (the hook: adjusted inputs before the director, a takeover after it), `audio/context.ts` (`setDevBusGain`, `busDuck`), `audio/music/player.ts` (position and duration in the status).

## Known gaps

- The director picks music by state only; intensity is a readout and a mapping condition, not stems. A mapped file plays over the whole state (no bar-synced transitions, no stems).
- Time, weather, freeze and demons are zone-wide (everyone on a dev zone hears them). Overrides last until cleared or the zone restarts.
- "Wilds" spots sit at area centres (one per 256 m area): biome-only searches are as fine as the area grid; peaks, shores and banks come from the atlas macro grid and the landing search snaps to real ground.
- Loaded files are decoded whole in memory (a 5-minute stereo WAV is ~110 MB decoded); built-in tracks forced or looped are decoded too (two kept).
