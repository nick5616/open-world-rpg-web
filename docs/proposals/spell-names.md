# Spell, technique and elemental form names

**Status: PENDING NICOLE'S APPROVAL.** Everything in the "Proposed" tables
below is a proposal. The game uses these names today, but only through one
table, `names:` in `contracts/combat.yaml` (keys on the left, display names
on the right). Every proposed key is also listed under `pending:` in that
file. To rename: edit the name in `contracts/combat.yaml`, run `npm run gen`,
done (the client, the zone and the HUD all read the generated table). To
approve: delete the key from `pending:`.

Author: WP13 · 2026-11-08

## The naming philosophy, as read from wizard-wars

Wizard Wars names do three things, and the proposals try to do the same:

1. **Short, physical, two words for the everyday spells.** A material or
   element plus what it does or how it moves: *Ember Flick*, *Frost Bite*,
   *Glacial Spike*, *Soul Drain*, *Thorn Dart*, *Spark Shot*. You can guess
   the spell from the name.
2. **Big, mythic or pop-culture names for the summits.** Pinnacles and
   domains get a name with weight and a wink: *Amaterasu*, *God Ray*,
   *Divine Judgement*, *Death Note*, *The Last Word*, *God's Edge*, *Event
   Horizon*, *Absolute Zero*. The description is then deadpan ("Write their
   name. They die.").
3. **A sense of humour.** *Gem Plop*, *Summon Airbud*, *Void Tap*. Names are
   allowed to be a bit silly when the spell is.

Spec 2's rule still applies: nothing is taken from Breath of the Wild,
Minecraft, Valheim or Demon Slayer. Real-world myth and idiom ("Act of God",
"High Noon") are fair game the way *Amaterasu* and *Death Note* were.

## Ported names (unchanged, already Nicole's)

Fire, Ice, Dark and the two halves of Earth (wizard-wars' Druid and
Crystalmancer) keep every wizard-wars name: *Ember Flick, Fireball,
Amaterasu, God Ray, Frost Bite, Glacial Spike, Absolute Zero, Divine
Judgement, Void Touch, Soul Drain, Event Horizon, Death Note, Thorn Dart,
Verdant Lance, Crystal Shard, The Monolith*, and the rest. Three wizard-wars
fire spells (*Lightning Strike*, *Static Charge*, *Chain Lightning*) moved to
the new Lightning tree with their names, because Lodestone has a Lightning
element of its own.

## Proposed: Lightning (Topaz)

| Key | Proposed name | Role | Why this name | Alternatives |
| --- | --- | --- | --- | --- |
| `static_step` | **Static Step** | mobility (40 m/s micro-dash) | a crackle and you're two metres over | Flash Step, Arc Step |
| `spark_jab` | **Spark Jab** | tier-1 fast bolt (shock) | a jab, not a haymaker; pairs with *Ember Flick* | Zap, Jolt |
| `ball_lightning` | **Ball Lightning** | slow orb that zaps everything it passes | the real phenomenon, self-explaining | Storm Orb |
| `thunderclap` | **Thunderclap** | self-centred stun burst | what it sounds like | Shockwave |
| `overcharge` | **Overcharge** | passive: +20 % vs shocked | the HUD word gamers know | Live Wire |
| `eye_of_the_storm` | **Eye of the Storm** | domain: lightning strikes around you | you are the calm centre | Storm Front |
| `act_of_god` | **Act of God** | pinnacle: a huge telegraphed strike | insurance-clause deadpan, in the *Death Note* register | Raijin's Verdict, Smite |

## Proposed: Wind (Aquamarine)

| Key | Proposed name | Role | Why | Alternatives |
| --- | --- | --- | --- | --- |
| `updraft` | **Updraft** | mobility: launches you up (then glide) | ties into the glider and fire's updrafts (spec 8 systems) | Lift, Tailwind |
| `gust` | **Gust** | tier-1 cone knockback | one syllable, does what it says | Shove |
| `razor_wind` | **Razor Wind** | piercing crescent | classic, physical | Wind Blade |
| `cyclone` | **Cyclone** | lifts enemies (airborne) | the shape it makes | Dust Devil |
| `downburst` | **Downburst** | aimed slam that stuns | real meteorology, sounds heavy | Sky Hammer |
| `crosswind` | **Crosswind** | passive: +15 % vs airborne | you hit them while they're up | Headwind |
| `howling_expanse` | **Howling Expanse** | domain: knockback storm | a place, not a spell | Gale Domain |
| `heavens_exhale` | **Heaven's Exhale** | pinnacle: a 70 m wind lance | the sky breathes out; *God Ray* register | Final Breath, Vacuum Edge |

## Proposed: Light (Sunstone), the anti-demon school

| Key | Proposed name | Role | Why | Alternatives |
| --- | --- | --- | --- | --- |
| `sunstep` | **Sunstep** | mobility: 8 m blink | stepping through sunlight | Glimmer Step |
| `glint` | **Glint** | tier-1 fast mote | the smallest unit of light | Sunmote |
| `radiant_lance` | **Radiant Lance** | piercing beam-spear | *Verdant Lance* sibling | Dawn Spear |
| `sunburst` | **Sunburst** | self burst that heals allies | what you see | Corona |
| `halo` | **Halo** | heal over time for your party | literal | Blessing |
| `dawnbreak` | **Dawnbreak** | aimed burn, the demon-killer | sunrise kills demons (spec 8) | Daybreak |
| `sunlit` | **Sunlit** | passive: +20 % vs dark | | Bright Soul |
| `high_noon` | **High Noon** | domain: allies heal, enemies burn | the showdown hour, a wink | Zenith |
| `let_there_be_light` | **Let There Be Light** | pinnacle: a 14 m flash | the most famous line about light; *The Last Word* register | Solar Verdict |

## Proposed: Void (Amethyst), the rarest gem

| Key | Proposed name | Role | Why | Alternatives |
| --- | --- | --- | --- | --- |
| `skip` | **Skip** | mobility: 10 m blink | reality skips a frame; *Gem Plop*-level understatement | Blink, Fold |
| `rift_shot` | **Rift Shot** | tier-1 bolt | a small tear | Null Bolt |
| `collapse` | **Collapse** | aimed pull-in burst | space folds inward | Implode |
| `unmake` | **Unmake** | x3 damage below 25 % | the void erases (spec 7) | Erase |
| `null_field` | **Null Field** | strips elite shields | | Zero Field |
| `hollow_echo` | **Hollow Echo** | passive: +10 % void | | Afterimage |
| `zero_point` | **Zero Point** | domain: everything pulled in | physics, cold and absolute | The Quiet |
| `unwritten` | **Unwritten** | pinnacle: erases a non-boss enemy (800 to bosses) | the answer to *Death Note* | Ctrl+Z (if you want the joke), Erasure |

## Proposed: weapon techniques

Spec 8's own examples keep their spec names (*Parry Riposte, Dash Cut,
Quick-Draw, Double Shot, Charged Pierce, Arrow Rain*, "Elemental Form"). New
ones:

| Key | Proposed name | Skill, level | What |
| --- | --- | --- | --- |
| `whirlwind` | **Whirling Cut** | Swordsmanship 40 | 360° heavy slash (V / middle mouse) |
| `sweep` | **Sweeping Strike** | Spearmanship 10 | the spear's second combo hit sweeps 120° |
| `impale` | **Impale** | Spearmanship 40 | a full charged thrust pierces |
| `mana_flow` | **Mana Flow** | Spellcraft 10 | +20 % mana regen |
| `quick_cast` | **Quick Cast** | Spellcraft 20 | -10 % cooldowns |
| `overflow` | **Overflow** | Spellcraft 30 | +15 % spell damage |
| `twin_cast` | **Twin Cast** | Spellcraft 40 | (data only in v1) |

## Proposed: elemental forms (sword and spear, by the socketed gem)

Spec 8: "Original names, approved by Nicole." The form fires with Q once
the weapon skill reaches 30 and a gem is socketed.

| Key | Proposed name | Gem | What |
| --- | --- | --- | --- |
| `form_fire` | **Wheel of Embers** | Ruby | spinning slash around you, burns (and will light dry grass with WP15) |
| `form_ice` | **Rime Crescent** | Sapphire | 120° frost arc that freezes |
| `form_lightning` | **Thunder Thread** | Topaz | a 10 m line of lightning that chains twice |
| `form_earth` | **Faultline** | Emerald | an 8 m shockwave line that stuns |
| `form_wind` | **Gale Step Cut** | Aquamarine | the spec's "8 m Wind form dash", cutting through everything on the way |
| `form_light` | **Dawn Arc** | Sunstone | wide radiant slash, double damage to demons (WP15 hook) |
| `form_dark` | **Hungering Cut** | Onyx | a slash that drinks half its damage back |
| `form_void` | **Severance** | Amethyst | a burst that drags enemies in |

## Enemy and boss names (not spells, but also new)

Original names, listed in `enemyNames:` and `bosses.titles:` of
`contracts/combat.yaml`: Thornback Boar, Mossjaw Wolf, Crag Ram, Rime
Stalker, Dust Scuttler, Bog Lurker, Bandit Cutthroat/Archer/Brute, Stone
Sentinel, Arcane Wisp, Ember Imp, Frost Mote, Spark Wisp, Mud Golem, Gale
Harpy, Lumen Moth, Shade, Void Mite, Cave Crawler, Gloom Bat, Crystal Golem;
bosses are the Warden and the Archon, titled by their arena's element ("The
Ashen Warden", "The Rimebound Archon", "The Unmade Warden", ...). These need
no sign-off by the spec, but they are just as easy to rename.
