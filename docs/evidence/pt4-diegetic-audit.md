# HUD audit for playtest 4 (`pt4/diegetic`, CR 052)

Method: the real client on a private zone (official world, `client/src/world/guide/dev/diegetic-shots.ts`) with a fresh character in the starting town, plus the mid-game states the dev console and the components' own conditions produce (hurt, in a fight, a level-up, a new quest step, a boss, a bounty board). Decision per element: **keep**, **relevant** (show only when it matters), **world** (moved into the world), **remove**.

## Always on screen (fresh character, before)

| Element | Where | Decision |
|---|---|---|
| Crosshair dot | centre | keep |
| Compass strip with the quest diamond and distances | top centre | keep (the diamond is now the main text-free pointer; the wisp and the beam back it up) |
| Clock / weather pill | top centre, under the compass | keep (small) |
| Friends / Graphics / Sound buttons | top right | keep |
| Quest tracker card (title, step text, "500 m south-west", "J journal, M map") | top right | **relevant**: opens on a step change, Tab, J; "where" text replaced by the wisp |
| Health and mana bars | bottom centre | **relevant**: not full or just changed |
| Hotbar (weapon, 4 spells, draught) | bottom centre | **relevant**: combat, boss, downed, hotbar keys, wheel, attack click |
| Key-hint line ("LMB attack ... B build") | under the hotbar | **remove** in Immersive HUD (Esc > Controls and tips teach keys when they matter) |
| "Click to look around" pill | above the hotbar | keep (needed once; hides while a panel is open) |
| Stamina wheel | beside the crosshair | keep (already fades when full) |
| Chat line / voice / party frame | bottom corners | keep (unchanged by brief) |
| Social status line ("retrying") | bottom right | keep (only when the service is down) |
| NPC and enemy name plates | in the world | keep (they are already in the world) |

## Transient text (before)

| Element | Decision |
|---|---|
| Quest notices (new quest, step, done, refused) | **relevant**: step notes removed (the tracker opening is the news), max 2, 3.5 s |
| Level-up banner (LEVEL UP / Level N / chips / "Health and stamina restored...") | **world**: glow around the character + the sound; the text is one small line (level + the first thing unlocked), 3.5 s |
| Region / discovery cards (big small-caps title, ornament rule) | **relevant**: the small "minor" size on a softer backdrop (first entry still announced once) |
| "[E] Talk" and other prompts | keep (they are the action) |
| Low-health tip | **world**: edge darkening + desaturation + heartbeat (tips content is pt4/first-hour's) |
| "500 m south-west" in the tracker | **world**: the guiding wisp (key `.`) with the compass diamond |
| Signpost text ("Signpost: Name 1.2 km" interaction line) | **world**: names and distances are on the boards themselves |
| Bounty board notices ("N notices pinned") | **world**: papers pinned on the board, one per untaken bounty (the panel still lists the details) |
| Loot toasts, achievement toasts, PvP kill feed, world event tracker, boss bar, vault/pet/camp strips, photo / emote / music overlays | keep (each only appears when its feature is in use; unchanged) |
| What's new / welcome card | keep (once per deploy) |

## Mid-game extras (hurt, in a fight, deeper in)

| Element | Decision |
|---|---|
| Boss bar with phase | keep (only in a boss fight) |
| Damage numbers, "Dodged!" toast | keep |
| Downed overlay | keep |
| Party frame | keep |
| Weather pill, night clock, Rested strip | keep |

## Result

The fresh character's screen goes from compass + buttons + tracker card + bars + hotbar + hint line + pill to compass + buttons + crosshair + pill (and the card for 9 s whenever a step changes). `docs/evidence/pt4-diegetic-hud.jpg` is the same moment with the switch on (left) and off (right).
