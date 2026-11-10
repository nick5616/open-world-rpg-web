# client/src/ui/camps

Playtest 2 camps in the browser (CR 025, `docs/cr/025-camps.md`). The zone owns every piece
(`server/zone/internal/game/camps*.go`, rules in `server/pkg/camps`); this folder shows them, previews
placement and sends Interact 90. Names and numbers come from `contracts/camps.yaml` (generated `CAMPS`).

| File | What |
| --- | --- |
| `events.ts` | Event kinds 1100-1119, Interact 90, refusal texts, decoders (piece records are binary), `placeTarget`, `labelChunks`, `PIECE` ids |
| `collide.ts` | the TS half of the solid-piece collision twin (`CampSet.after`, bit for bit with `server/pkg/camps`) and `CampGround` (WorldRuntime.ground, over the door ground) |
| `placement.ts` | the placement rules (mirror of `camps.Check`), footprints, separating axes, the ghost's spot and facing |
| `ghost.ts` | the live ghost: the rules over the loaded runtime (terrain, water, settlements, town boxes) and the pack's kits |
| `store.ts` | zustand: pieces by id, your camp and map markers, the open chest, Rested, notes, placement mode; `reduceCampEvent` is pure; rebuilds the solid set |
| `link.ts` | hooks the live session (NetPlay calls `ensureCampHook` before Hello) |
| `models.ts` | low-poly procedural pieces and deadfall branches |
| `CampLayer.tsx` | in-world: pieces, flames (the night layer's cards), lights, embers, fire audio loops, deadfall, the ghost |
| `CampHud.tsx` | the camp menu (P), placement controls, `[E]` prompt and hold-E pick up, chest panel, signpost name, fuel strip, Rested / by-the-fire badges, notes, `window.__lodestoneCamps` (debug builds) |
| `dev/camp-shots.ts` | headless evidence: `cd client && npx vite-node src/ui/camps/dev/camp-shots.ts` |

Controls: **P** camp menu (craft kits, Place). Placing: **wheel** or **R** turns 45 degrees, **left mouse** places
(green only), **right mouse** or **Esc** cancels. **E** on a piece uses it (cook / light, rest, open, name);
**hold E** on your own piece picks it up.
