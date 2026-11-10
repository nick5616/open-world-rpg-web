# Taming and pets (playtest 2, CR 029)

`docs/cr/029-pets.md` is the contract; the zone is `server/zone/internal/game/pets.go`.

| File | What |
| --- | --- |
| `events.ts` | Events 1200-1205 decoders, Interact 130 actions and commands, refusal and interruption texts, the numbers the zone uses (meter time, XP curve, stats, liked food), the crosshair pick for "attack that" (`pickAlong`), the pet wheel's sectors, name chunks |
| `store.ts` | `reducePetEvent` (pure): your pets (1200), calm creatures (1201), the taming meter and the tame (1202), notes (1203, 1204), recent acts (1205) |
| `link.ts` | hooks the live session (`ensurePetHook`, called by NetPlay before Hello and by the HUD on a timer) |
| `PetHud.tsx` | keys (6 tap: attack the aimed creature or heel; 6 held: the pet wheel; 7: stay / follow; E: feed a calm creature, else pet your pet), the prompts, the meter, the pet card, notes, the pet panel (Character → Your pets) |
| `PetLayer.tsx` | in the world: a "?" over calm creatures, hearts while feeding, the tame's burst, petting hearts, ability rings |
| `dev/pet-shots.ts` | evidence: `cd client && npx vite-node src/ui/pets/dev/pet-shots.ts` (one zone, one Vite, one browser) |

The pet itself is drawn by the enemy renderer: `combat/enemies/spec.ts` `petSpec` (EntityKind effect with typeId bit 15:
the creature's model, a friendlier tint, a collar from `models.ts`, gold for a shiny, the element's accent and ring for an
elemental), green health bar, a warm nameplate ("Owner's Name"). The bestiary (`ui/content/JournalTabs.tsx` `TameRow`) says
which creatures can be tamed, with what, and the pet's ability. The petting pose is emote 25 (`net/avatarAnim.ts`).
