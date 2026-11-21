// Playtest 6 polish: townsfolk nameplates that stand close together drew over
// each other ("Pelm Kelmir / vil bounty keeper"). Labels are placed nearest
// first; a farther label that would overlap one already placed is lifted just
// above it (a short stack reads as "the one behind"), and hidden when the
// lift would be large (a crowd: the nearer names are what you need).

/** A label's screen box: x is its horizontal centre, y its bottom edge (CSS px, y down). */
export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where each label goes: its bottom edge moved up by `lift` px, or hidden. */
export interface LabelPlace {
  lift: number;
  hidden: boolean;
}

/** Gap kept between stacked labels (px). */
const GAP = 2;

/**
 * Lay out labels given nearest first. `maxLift` is how far a label may be
 * moved up (px) before it is hidden instead; `fixed` boxes are already there.
 */
export function declutterLabels(boxes: readonly LabelBox[], maxLift = 40, fixed: readonly LabelBox[] = []): LabelPlace[] {
  // `fixed`: boxes that never move (speech bubbles): labels make room for them too.
  const placed: { l: number; r: number; t: number; b: number }[] = fixed.map((f) => ({ l: f.x - f.w / 2, r: f.x + f.w / 2, t: f.y - f.h, b: f.y }));
  const out: LabelPlace[] = [];
  for (const bx of boxes) {
    const l = bx.x - bx.w / 2;
    const r = bx.x + bx.w / 2;
    let b = bx.y;
    // Lift above every placed box this one runs into, until it is clear
    // (each pass moves it up, so this ends after at most placed.length passes).
    for (let pass = 0; pass <= placed.length; pass++) {
      const t = b - bx.h;
      const hit = placed.find((q) => l < q.r && r > q.l && t < q.b && b > q.t);
      if (!hit) break;
      b = hit.t - GAP;
    }
    const lift = bx.y - b;
    if (lift > maxLift) {
      out.push({ lift: 0, hidden: true });
      continue;
    }
    placed.push({ l, r, t: b - bx.h, b });
    out.push({ lift, hidden: false });
  }
  return out;
}
