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
