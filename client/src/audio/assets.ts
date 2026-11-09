// Processed audio assets (built by tools/audio/build-audio.mjs from Nicole's
// tracks and the Novation packs; see client/src/audio/README.md). They are
// imported through Vite so they get content-hashed /assets/ names and the
// immutable cache headers every other hashed asset has (infra/netlify
// client._headers). The glob only puts URL strings in the bundle: nothing
// downloads until the engine fetches a cue, after the first playable frame.
//
// Two encodings of every file: Ogg Opus (smaller, Chrome/Firefox/Edge and
// recent Safari) and AAC in .m4a (Safari's safe choice). Each client fetches
// only one of them.

const OGG = import.meta.glob('./assets/**/*.ogg', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const M4A = import.meta.glob('./assets/**/*.m4a', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

function canOpus(): boolean {
  try {
    if (typeof document === 'undefined') return true;
    const a = document.createElement('audio');
    return a.canPlayType('audio/ogg; codecs="opus"') !== '';
  } catch {
    return false;
  }
}

let opus: boolean | null = null;

/** The URL of an asset by its name ("music/day_1", "sfx/ui_click_1"), in the encoding this browser plays. */
export function assetUrl(name: string): string | null {
  if (opus === null) opus = canOpus();
  const key = `./assets/${name}`;
  return (opus ? OGG[`${key}.ogg`] : M4A[`${key}.m4a`]) ?? OGG[`${key}.ogg`] ?? M4A[`${key}.m4a`] ?? null;
}

/** Every asset name present (tests, the cue sheet check). */
export function assetNames(): string[] {
  const names = new Set<string>();
  for (const k of [...Object.keys(OGG), ...Object.keys(M4A)]) names.add(k.replace(/^\.\/assets\//, '').replace(/\.(ogg|m4a)$/, ''));
  return [...names].sort();
}

/** Force the encoding (tests, the headless check). */
export function setOpusForTests(v: boolean | null): void {
  opus = v;
}
