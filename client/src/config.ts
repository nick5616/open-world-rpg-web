// Build/runtime flags. VITE_SOLO=1 is set by `npm run dev:solo`
// (scripts/dev.mjs): the client runs with no servers at all.

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);

/** No director/account/zone: skip sign-in, walk the local placeholder world. */
export const SOLO = import.meta.env.VITE_SOLO === '1' || params.has('solo');

/**
 * Debug tools (spec 14): HUD, teleport, fly, freeze time, cell borders, the
 * window.__lodestone handle. On in dev and solo builds; a production build
 * only shows them with ?debug=1, so players never stumble into fly mode.
 */
export const DEBUG = import.meta.env.DEV || SOLO || params.has('debug');

/** Skip the title screen (headless captures, quick iteration): ?autoplay=1 */
export const AUTOPLAY = params.has('autoplay');
