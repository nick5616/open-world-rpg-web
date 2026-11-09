# server/zone/cmd/nightbots

WP15's networked acceptance: headless fighters (internal/combat/combatbot's
Brain, plumbing adapted from cmd/combatbots) against a real zone process at
night on the official world.

- `-scenario demon`: one bot raises a pack (dev Interact 52/3), fights it
  40 s with an ordinary sword (every demon must survive), takes a sunsteel
  blade (dev Interact 50/6: `Loadout.material = sunsteel`) and kills them,
  then raises another pack and sets the clock to just before dawn (dev
  Interact 52/2): sunrise must burn them.
- `-scenario defense`: two bots with sunsteel at a town's ward garden; the
  ward falters (dev Interact 52/1) and they fight the three waves; PASS when
  the ward holds and both are rewarded.

Run everything (builds the zone and the bots, starts the zone at 22:00 world
time with no Postgres/Redis, writes `docs/evidence/wp15-{demon,defense}.*`):

```
node server/zone/cmd/nightbots/acceptance.mjs [--only demon|defense]
```

Needs Go and `npm run build:wasm`.
