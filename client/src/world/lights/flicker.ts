// A gentle flame flicker: a few slow sines, never a strobe (CR 042; "Reduce
// flashing" scales the swing down further). Pure, so it is tested for its
// range and its fastest change.

/** 1 +- swing: three incommensurate sines, the fastest 3.1 Hz. `seed` decorrelates flames. */
export function flameFlicker(tSeconds: number, seed: number, swing: number): number {
  const a = Math.sin(tSeconds * 2.3 + seed * 1.7);
  const b = Math.sin(tSeconds * 3.1 + seed * 4.1 + 1.3);
  const c = Math.sin(tSeconds * 0.9 + seed * 2.9 + 2.1);
  return 1 + swing * (0.45 * a + 0.3 * b + 0.25 * c);
}

/** The swing a flame uses: 8% normally, 3% with Reduce flashing on. */
export function flickerSwing(reduceFlashing: boolean): number {
  return reduceFlashing ? 0.03 : 0.08;
}

/** A slow breathing pulse for magical lights (0.5 Hz): 1 +- swing. */
export function breathe(tSeconds: number, seed: number, swing: number): number {
  return 1 + swing * Math.sin(tSeconds * Math.PI + seed * 2.3);
}
