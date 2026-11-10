# client/src/ui/mounts

Playtest 2 mounts (CR 027, `docs/cr/027-mounts.md`): the spirit steed in the browser. The zone owns steeds
(`server/zone/internal/game/mounts.go`); riding is the shared movement step (`client/src/sim/ride.ts`, twin
`server/pkg/movement/ride.go`). Numbers: `contracts/constants.yaml` group `mounts`.

| File | What |
| --- | --- |
| `events.ts` | Events 1140-1159, Interact 110, phases, the typeId riding bit, colours, refusal / thrown texts, decoders, `steedPose` (arriving / bolting), `nameChunks` |
| `store.ts` | zustand: your steed (1140), every steed told (1141, by owner), notes, the panel; `reduceSteedEvent` is pure; `steedLookOf` for avatars |
| `link.ts` | hooks the live session (NetPlay calls `ensureMountHook` before Hello) |
| `model.ts` | `SteedRig`: the low-poly spectral steed (walk / trot / gallop leg cycles locked to speed, body bob and rock, head nod, mane ripple, tail stream, saddle, reins to the rider's hands, aura, fading, a first-person view of the neck and head) |
| `SteedLayer.tsx` | in-world steeds nobody sits on (arriving, standing, bolting); ridden ones are drawn under their rider by `net/avatar.ts` |
| `MountHud.tsx` | key 5 whistle, E ride / get off, spur pips, notes, the steed panel (name, colour, whistle, send away), `window.__lodestoneMounts` |
| `dev/mount-shots.ts` | headless evidence: `cd client && npx vite-node src/ui/mounts/dev/mount-shots.ts` |

Riders: `net/avatar.ts` sees typeId bit 14 and seats the rig (`avatarAnim.ts` riding pose) on a `SteedRig` facing the
drawn motion; your own body (`scene/LocalAvatar.tsx`) sets the bit from your state. `scene/PlayerController.tsx` raises the
eye (RIDE_EYE_RAISE_M) and pulls the third-person boom back 1.6 m in the saddle; `combat/dashFeel.ts` adds the gallop's
FOV kick; `combat/timeline.ts` refuses dodges, dashes, forms and sword/spear moves from the saddle.
