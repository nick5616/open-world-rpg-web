// Playtest 2 immersion pass: the story's big moments (the Hush's entrance,
// the ending and its credits) play with the world and nothing else. While
// one runs, every HUD element is hidden (cards, tips, the quest tracker, the
// boss bar, the hotbar, nameplates, a welcome card that happened to be up):
// one stylesheet rule hides every element that neither holds the 3D canvas
// nor sits inside a `data-cinematic-keep` subtree. Nested holders are counted,
// so one moment handing over to the next never flashes the HUD back for a
// frame. Hidden, not removed: React state, timers and the panel stack go on
// as before, and the HUD returns as it was.

const STYLE_ID = 'ls-cinematic-style';
export const CINEMATIC_RULE = [
  'body[data-cinematic] *:not(canvas):not(:has(canvas)):not([data-cinematic-keep]):not([data-cinematic-keep] *) { visibility: hidden !important; }',
  'body[data-cinematic] [data-cinematic-keep], body[data-cinematic] [data-cinematic-keep] * { visibility: visible !important; }',
].join('\n');

let holders = 0;

/** True while a cinematic holds the screen (other UI can wait: the welcome card). */
export function cinematicActive(): boolean {
  return holders > 0;
}

/** Hide the HUD until the returned release is called (the release is idempotent). */
export function holdCinematic(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CINEMATIC_RULE;
    document.head.appendChild(s);
  }
  holders++;
  document.body.dataset.cinematic = '1';
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (!holders) delete document.body.dataset.cinematic;
  };
}
