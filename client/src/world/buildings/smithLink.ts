// A hand-off between the townsfolk renderer and the audio engine's forge
// ambience (audio/engine.ts hammering): when a visible blacksmith is
// hammering at an anvil, his own blows (npcs.ts: a clang on every strike,
// matched to the arm) replace the forge's random strikes, so the sound and
// the animation never disagree. Plain module state, written per frame.

export interface SmithAt {
  x: number;
  z: number;
  /** performance.now() until which this entry counts. */
  until: number;
}

const smiths: SmithAt[] = [];

/** The renderer notes a smith hammering at (x, z) this frame. */
export function noteSmith(x: number, z: number, nowMs: number): void {
  for (const s of smiths) {
    if (Math.hypot(s.x - x, s.z - z) < 1) {
      s.until = nowMs + 400;
      return;
    }
  }
  if (smiths.length < 16) smiths.push({ x, z, until: nowMs + 400 });
}

/** True when a visible smith has been hammering within `r` m of (x, z) lately. */
export function smithNear(x: number, z: number, nowMs: number, r = 7): boolean {
  for (let i = smiths.length - 1; i >= 0; i--) {
    const s = smiths[i];
    if (s.until < nowMs) smiths.splice(i, 1);
    else if (Math.hypot(s.x - x, s.z - z) < r) return true;
  }
  return false;
}
