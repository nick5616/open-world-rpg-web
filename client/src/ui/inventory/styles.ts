// Shared CSS for the inventory, crafting panel and loot HUD (WP14): one
// <style> element injected on first mount. The holographic classes are the
// Bitchin' rarity's "colour" (contracts/items.yaml: color holographic): an
// animated rainbow gradient on text, borders and the announcement banner.

export const PANEL_BG = 'rgba(18,16,14,0.9)';
export const PANEL_BORDER = 'rgba(232,196,106,0.45)';
export const GOLD = '#f3d48a';
export const TEXT = '#efe6d2';

// The rainbow twice over, drawn at 200% width: every visible half holds the whole spectrum and the loop is seamless.
const HOLO = 'linear-gradient(90deg,#ff5ef0,#7a6bff,#5ef1ff,#8dff6b,#ffe45e,#ff9a5e,#ff5ef0,#7a6bff,#5ef1ff,#8dff6b,#ffe45e,#ff9a5e,#ff5ef0)';

const CSS = `
@keyframes lsHoloShift { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
@keyframes lsHoloBorder { 0% { background-position: 0 0, 0% 50%; } 100% { background-position: 0 0, 200% 50%; } }
@keyframes lsBannerIn { 0% { opacity: 0; transform: translateX(-50%) scale(0.6); } 12% { opacity: 1; transform: translateX(-50%) scale(1.08); } 20% { transform: translateX(-50%) scale(1); } 85% { opacity: 1; } 100% { opacity: 0; transform: translateX(-50%) scale(1.02); } }
@keyframes lsGlow { 0%, 100% { filter: drop-shadow(0 0 8px rgba(255,94,240,.75)) drop-shadow(0 0 22px rgba(94,241,255,.45)); } 50% { filter: drop-shadow(0 0 14px rgba(94,241,255,.9)) drop-shadow(0 0 34px rgba(255,228,94,.55)); } }
@keyframes lsToastIn { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }
.ls-holo-text { background: ${HOLO}; background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent !important; text-shadow: none !important; animation: lsHoloShift 2.6s linear infinite; }
.ls-holo-border, .ls-tile.ls-holo-border { border-color: transparent !important; background: linear-gradient(var(--ls-tile-bg, #1d1915), var(--ls-tile-bg, #1d1915)) padding-box, ${HOLO} border-box; background-size: 100% 100%, 200% 100%; animation: lsHoloBorder 2.6s linear infinite; }
.ls-holo-bar { background: ${HOLO}; background-size: 200% 100%; animation: lsHoloShift 2.6s linear infinite; }
.ls-banner { animation: lsBannerIn var(--ls-banner-ms, 7000ms) ease-out forwards; background: radial-gradient(ellipse at center, rgba(14,8,26,0.82) 0%, rgba(14,8,26,0.55) 55%, rgba(14,8,26,0) 75%); padding: 26px 40px; }
.ls-banner-text { animation: lsHoloShift 2.2s linear infinite, lsGlow 1.6s ease-in-out infinite; }
.ls-toast { animation: lsToastIn .25s ease-out; }
.ls-inv button { font: 600 12px system-ui, sans-serif; padding: 4px 10px; border-radius: 4px; border: 1px solid #c9a650; background: #4f3e22; color: #f6e7c0; cursor: pointer; }
.ls-inv button:hover:not(:disabled) { background: #6a5330; }
.ls-inv button:disabled { background: #2e2a24; border-color: #5a5040; color: #8d8270; cursor: default; }
.ls-inv button.ls-danger { border-color: #c96a50; background: #4f2a22; }
.ls-tile { position: relative; width: 52px; height: 52px; box-sizing: border-box; border: 2px solid #3a342a; border-radius: 6px; background: #1d1915; display: grid; place-items: center; cursor: pointer; user-select: none; }
.ls-tile:hover { filter: brightness(1.25); }
.ls-tile.ls-empty { border-style: dashed; border-color: #3a342a; background: rgba(29,25,21,0.55); cursor: default; }
.ls-tile.ls-sel { box-shadow: 0 0 0 2px #fff6, 0 0 12px #fff4; }
.ls-tile.ls-drop { box-shadow: 0 0 0 2px #9fe6ff; }
.ls-qty { position: absolute; right: 3px; bottom: 1px; font: 700 11px system-ui, sans-serif; color: #fff; text-shadow: 0 1px 2px #000, 0 0 3px #000; }
.ls-dot { position: absolute; top: 3px; width: 6px; height: 6px; border-radius: 50%; border: 1px solid #0008; }
.ls-better { position: absolute; right: 3px; top: 1px; font: 700 12px system-ui, sans-serif; color: #5ee05e; text-shadow: 0 1px 2px #000, 0 0 3px #000; pointer-events: none; }
`;

export function ensureInventoryStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('ls-inv-styles')) return;
  const el = document.createElement('style');
  el.id = 'ls-inv-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}
