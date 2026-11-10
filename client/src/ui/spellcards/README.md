# Spell cards (playtest 2)

Nicole: "make this screen have higher contrast ratio in text ... maybe we do
spell cards instead of a dropdown and each of them shows deep info on hover
but class and type on the spell card not on hover."

The character panel (C) shows the loadout's four slots and the known
castable spells as cards; the skill tree (N) uses the same slot cards and
tooltip. Every card face shows name, school (colour + glyph), type, tier,
damage (or heal / shield / ally hits), mana (per shot for streams) and
cooldown. Hover or keyboard focus: the deep info (the skill tree's
`spellFacts`, passive lines, "your hit" with the active build, which slots
hold it). Assign by click (pick a card, click a slot), by dragging a card
onto a slot (pointer drag with a ghost card; slot to slot moves), or by
keyboard (Enter picks, Enter on a slot places, Delete clears); x clears a
slot. A toggle shows either loadout. Assignment is the existing
`equipSpell` Interact (50/3); no contract change.

| File | What |
| --- | --- |
| `card.ts` | Pure: `spellCardData` (school, type: the CR 020 mechanic when there is one (Stream, Homing, Charge, Brand, Orbit, Summon, Volley...) else the delivery, tier, mana, headline number, cooldown), `knownCards`, `slotsHolding`, the school glyphs |
| `theme.ts` | Colour tokens for the panel and cards (no opacity-dimmed text) and the WCAG contrast maths |
| `SpellCards.tsx` | `SpellCardFace`, `SpellDetail` (deep info), `SpellTooltip`, `SlotCard`, `SpellBoard` (the panel's section) |
| `dev/shots.mjs` | Solo headless run: clicks, drags, keyboard, both loadouts; `docs/evidence/pt2-spell-cards-*.png` at 1920x1080 and 1280x720 |

Tests: `spellcards.test.ts` (card data for every spell in combat.yaml, the
mechanic types, headline numbers, grid order, slots) and `theme.test.ts`
(every text token and school colour on every panel surface is at least
4.5:1, the translucent panel checked over a black and a white world).

```
npx vitest run --root client src/ui/spellcards
node client/src/ui/spellcards/dev/shots.mjs
```
