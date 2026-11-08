# 0010: Movement extensions (WP10)

Date: 2026-11-08

## Everything lives in the one shared step

Climb, glide, swim, slopes, stamina, rain slips and even the drowning
respawn are inside `stepMovement` / `movement.StepEnv`, run identically by
client prediction and the zone. The alternative (server-only rules with the
client corrected afterwards) costs a visible correction for every mode
change. Measured result: 0 corrections across all acceptance runs; divergence
is cm quantization only (max 0.84 cm). Things the step cannot know (rain,
updrafts) come in as an explicit `StepEnv`, evaluated on both sides from the
same synced inputs.

## Slopes from heightAt alone, thresholds as literals

`ground_normal` exists in the wasm, but the step derives the slope from four
`heightAt` samples (central differences over 1 m). That needs no new
interface (WP05's chunk-backed ground only has to answer heights), smooths
single 1 m triangles of the collision mesh, and is bitwise identical on both
sides because `heightAt` is. Slope limits are compared as `tan²` against
literal constants (`WALKABLE_TAN_SQ`, `CLIMB_MAX_TAN_SQ`) because `Math.tan`
and Go's `math.Tan` may differ by an ulp; tests check the literals against the
degree constants.

## Heightfield climbing

The world is a heightfield (caves are WP09), so a "wall" is just steep
ground. Climbing moves the player over the surface at CLIMB_SPEED measured
along it, with input relative to the wall (up/down/contour), and keeps them
standing on it. Letting go is standing on a too-steep slope, which slides you
down: no special falling-off state. Mantle = reaching walkable ground while
moving up, with a small forward push. With the contract's numbers (10/s drain,
2 m/s) a full wheel climbs 20 m of surface; most steep terrain in the world is
long 55-65° faces, so the acceptance cliff is a 14.5 m one (sites in
`docs/evidence/wp10-sites.txt`). Hanging still costs nothing (as in the north
star), moving drains.

## Jump, double jump, glider

Spec: "glide by pressing jump in the air"; the game also has a double jump.
Rule: in the air a press uses the double jump first; the next press (falling,
more than GLIDE_MIN_FALL_M up) opens the glider. G (`glide_toggle`) opens or
closes it directly, keeping the double jump. Opening spends the air jumps so
toggling can never chain double jumps. Requiring `vy < 0` keeps WP02's
"refused third jump" golden unchanged and matches "glide from any fall".

## Stamina as integers, the wire carries it exactly

Stamina is integer fine units (60 per point) so 10/s is exactly 10 per step;
`SelfState.stamina` (x10) cannot carry that, so CR 004 appends `moveExt`
(stamina + mode timer). Without exact stamina a replay from a snapshot would
run out a step early or late and turn one correction into a chain.

## Drowning respawn is deterministic

`findShore` (rings, 8 directions, first dry walkable point) runs inside the
step on both sides, so client and server teleport to the same spot with no
message; the zone's `drowned` event is only for UI. Swim drain limits how far
from shore anyone can drown (~37 m of swimming per wheel, plus a glide), so
the search stays short.

## Rain from world time

The weather stub hashes (seed, 10-minute window of the zone's server clock).
The zone applies it per tick; clients evaluate it at their ClockSync estimate.
Near a window boundary the two can disagree for a few ms: at most one
correction while climbing, every 10 minutes. Not worth a wire field.

## Validation per mode

The zone's checks stay a tripwire (the step is the server's own; input is
the only thing a client controls, and the frame budget bounds simulation
time): per-mode horizontal bounds (a mode-changing step gets both modes'
bounds, since it ran the old mode's physics), a vertical bound at the fastest
legal upward speed of any mode (jump, carried vy, strongest updraft, lunge) or
onto the ground / float level, and a drowning respawn must land on dry
ground. All eight terrain goldens pass it frame by frame.

## Towers are just ground

WP12's towers are a structure overlay combined with the terrain by max
(`StructureGround` / `structures.Ground`), with 80° walls and a walkable
ledge. The step reads only `heightAt`/`waterAt` of whatever ground it is
given, so on the combined ground towers are climbed with stamina (resting on
the ledge refills the wheel), mantled, and glided from, with no
tower-specific code. Water passes through to the terrain's.
