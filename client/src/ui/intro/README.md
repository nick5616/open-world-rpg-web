# Discovery intros

Playtest feedback: "take the location intros from 3d-portfolio-site. How
grandiose location discovery is." When you discover a place, its name comes
up big in the top third of the screen, BotW style: cream serif small caps, an
ornament rule with a glowing diamond, the kind of place and its region under
it, and a low swell that blooms into a chime.

Ported from Nicole's **3d-portfolio-website** (look and timing; the code is
rewritten for this client's plain React + inline styles):

| Reference | Here |
| --- | --- |
| `src/components/ui/HudToasts.tsx`: region reveal (`botw-region` > `botw-title` + `botw-rule` + `gem-label`), `REGION_SUBTITLES` | `DiscoveryIntro.tsx` (`IntroCard`, `Rule`), subtitles from the site kind (`intros.ts` `siteKindLabel`) |
| `src/styles/gem.css` `--gem-display: "Fraunces", Georgia, serif`; `.botw-title` small caps, letter-spacing 0.03em, cream `#f3ead2`, warm glow | same font stack (Google Fonts link injected on mount; offline it falls back to Georgia), same colors and shadows |
| `.gem-label`: Fraunces 600, small caps (lowercased), letter-spacing 0.18em, cream at 80 % | `label()` in `DiscoveryIntro.tsx` |
| `.botw-rule`: 1 px cream lines fading out, 7 px diamond (cream border, Sheikah cyan `#4fdcff` + glow) | `Rule`; the diamond takes the place's accent (gold town, red tower, violet cave...) |
| `@keyframes botw-region`: 3.4 s, `ease-in-out`; 0-18 % fade in from 6 px below, hold to 78 %, fade out | `queue.ts` `IN_FRAC` 0.18 / `OUT_FRAC` 0.22; totals per variant below |
| `.botw-announce` blur-in, `.botw-prompt` shadow pool | 3 px blur on the way in; a radial dark pool behind the text so it reads on a bright sky |
| (no sound: the reference reveal is silent) | `sting.ts`: synthesized WebAudio sting |

Additions for "grandiose": the title tightens from 0.24em to 0.03em letter
spacing as it lands (1.6 x the fade-in, expo ease-out), the rule draws out from
the centre and the diamond pops, subtitle and XP line follow at 55 % / 80 % of
the fade-in. `prefers-reduced-motion` keeps only the fades.

## Variants and triggers

| Variant | Total (ms, alone) | Size (title) | Sting | Triggered by |
| --- | --- | --- | --- | --- |
| `region` | 5200 | 38-64 px | grand (A C# E A over a swell) | **Event 600 `tower_unlocked`** ("Region revealed" + region name + biome, "Map updated · tower unlocked for fast travel"); **first entry into a region this session** (position poll, 1.5 s settle; "Uncharted · climb its tower to map it" until revealed) |
| `major` | 4400 | 32-52 px | swell + A E A | **Event 602 `discovery`**: towns/villages/hamlets, towers, caves, structures (ruins, shrines, ...), landmarks. Title = name (or the kind when unnamed), subtitle = "Village · Ashen Vale", "Tower of <Region>", "Cave", "Ruins · <Region>", detail = "+80 XP" |
| `minor` | 3000 | 24-34 px | soft E A chime | **Event 601 `waypoint_activated`** |
| `card` | 2800 | 22-30 px | none | walking back into a **known** town (the reference shows a name on every room entry); rate-limited: same town once per 120 s, any card once per 20 s, never within 60 s of that town's discovery, never queued (dropped when anything else is up) |

The big intro replaces the WP12 discovery / tower / waypoint toasts
(`INTRO_TOAST_KINDS`; ExplorationHud stops drawing them, the store still keeps
them for scripts). Level-up, respawn and the rest stay as toasts; the intro
sits below them (`top: max(18vh, 64 px + toasts)`), under the compass and
clear of the crosshair, `pointer-events: none`, z-index 14 (under the map).

## Queue (`queue.ts`)

- One at a time, FIFO; the next starts when the last has faded out.
- Dedupe per session by key: `site:<i>`, `reveal:<r>`, `region:<r>`,
  `waypoint:<i>`, `attuned:<i>`. A reveal also covers `region:<r>` (no "you
  entered X" right after "X revealed").
- Collapse: with two or more waiting, the intro on screen cuts its hold to
  700 ms after its fade-in, and the next ones play at pace 0.75 (one behind)
  or 0.55 (two or more behind). Over 4 waiting, the lowest-priority oldest is
  dropped (card < minor < major < region).
- Events that arrive before the atlas has loaded (joining on a tower top) wait
  for it (up to 8 s) so the intro has names and kinds.

## tower_attuned

Not in `contracts/events.md` yet (the progression work may add it). The
builder is ready (`intros.ts` `towerAttunedIntro`: "Tower attuned" eyebrow,
tower name, "Tower of <Region>", +XP from `value`; assumes `targetId` = tower
site like 600). When the Event lands, add its number to `EV` in
`ui/map/events.ts` and one line to `INTRO_FOR_EVENT`:

```ts
  [EV.towerAttuned]: towerAttunedIntro,
```

## Sound

`sting.ts`: one AudioContext created on the first key/click; nothing plays
before that, when the tab is hidden, or at volume 0. Volume is
`localStorage["lodestone.intro.volume"]` (0..1, default 0.6). The client has no
global sound settings yet; when it gets them, read them in `stingVolume()`.

## Dev handle

`window.__lodestoneIntro` (debug builds / `?debug=1`):

```js
__lodestoneIntro.show({ title: 'Draedmore', subtitle: 'Town · The Burning Leas', detail: '+100 XP', variant: 'major', accent: '#ffd166' })
__lodestoneIntro.state()    // current, queue
__lodestoneIntro.history()  // every intro shown this session
__lodestoneIntro.skip()
__lodestoneIntro.volume(0.3)
```

## Evidence

`cd client && npx vite-node src/ui/intro/dev/intro-shots.ts` runs the real
client against the real zone (seed 20261108, no DB, dev tickets, random ports
in 20000-45000) and drops fresh characters just outside sites so the zone's
own discovery Events trigger the intros: `docs/evidence/pt-ux-intro-*.png`
(`discovery` mid-animation, `town`, `tower`, `region` (600), `region-entry`,
`frames-1..3`, `1080`, `800`) and `pt-ux-intro-shots.txt`.
`pt-ux-intro-reference.png` is the reference site's reveal (its built `dist`,
served read-only).
