# server/pkg/weather

WP10's deterministic weather stub until the night/chemistry package (WP15)
owns weather. Spec 8: weather is a function of world time and the seed, so
it needs no sync beyond the clock. Movement needs one bit, rain (climb speed
halved, slips every few seconds), so:

```
window = floor(worldTime / WEATHER_STUB_WINDOW_S)       // 600 s
rain   = fmix32(seedLo ^ seedHi*0x9e3779b1 ^ window*0x85ebca6b) % 100 < WEATHER_STUB_RAIN_PCT   // 25
worldTime = serverTimeMs / 1000                          // the zone clock (Unix), which clients sync
```

The TS twin is `client/src/sim/weather.ts`; both test the same hash vectors
(`weather_test.go`, `client/src/sim/traversal.test.ts`). The zone evaluates
it once per tick (`game.Server.stepEnv`), clients per predicted step at
their synced estimate of the server clock; a few ms of disagreement at a
window boundary costs at most one correction while climbing.
`LODESTONE_ZONE_DEBUG_RAIN=1|0` overrides it on the zone (client: `?rain=1|0`).

Test: `cd server/pkg && go test ./weather`.

## The world clock (WP15)

`clock.go` owns world time now: `Clock{Seed, OffsetS}.WorldTime(serverMs)`
(the offset is the world's `LODESTONE_ZONE_TIME_OFFSET_S`, announced to
clients in Event 500), `Hour`, `IsNight` (18:30-06:00), `NightIndex`,
`MoonPhase` (seeded 8-night cycle), `MoonDemonFactor`, the chemistry step
(`Step`, `RainingAtStep` on whole steps) and the chemistry wind (`WindAt`).
`IsRaining` keeps WP10's vectors; the zone now evaluates it at world time.
TS twin: `client/src/systems/clock.ts`; both replay
`testdata/clock_vectors.json` (`go test ./weather -run ClockVectors -update`
rewrites it).

## Dynamic weather (playtest 2, CR 030)

`states.go` owns the weather now (`docs/cr/030-weather.md`): eleven states
(clear .. sandstorm) per 512 m cell, from a climate voted over the atlas
biome grid (`NewClimate`) and a severity roll per 2 x 2 front and 10-minute
window (seeded phase per front, a per-cell nudge). `StateAtStep`, `Next`,
`WindLevel`, `MoveSpeedMult`, `GlidePush`, `ArrowAccel`, the per-step
`Field` the movement `Env` reads (`MoveField`), and the lightning schedule
(`StrikeInSlot`, `StrikesBetween`, `TallSpot`). TS twin:
`client/src/systems/weather/weather.ts`; both replay
`testdata/weather_vectors.json` (`go test ./weather -run WeatherVectors
-update` rewrites it). `IsRaining` / `RainingAtStep` stay: worlds without an
atlas (the flat and scale worlds) and the clock vectors use them.
