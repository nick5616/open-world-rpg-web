// Title screen (pt3 title + creation, CR 047): the game's own gem cavern behind
// a strong logotype. First paint is the logotype over a CSS cavern (no
// three.js, no worldgen wasm); the live 3D cavern is a lazy chunk that fades in
// over it. Without WebGL (or `?cave=0`) the CSS cavern is the whole backdrop.
import { useEffect, type CSSProperties } from 'react';
import { PROTOCOL_VERSION } from '@lodestone/contracts';
import { useAppStore } from '../stores/appStore';
import { SOLO } from '../config';
import { CaveBackdrop } from './stage/CaveBackdrop';

export function TitleScreen() {
  const start = useAppStore((s) => s.startFromTitle);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Enter' || e.code === 'Space') start();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [start]);

  return (
    <CaveBackdrop variant="title">
      <style>{TITLE_CSS}</style>
      <div style={centre}>
        <svg className="ls-mark" width="74" height="86" viewBox="0 0 74 86" aria-hidden>
          <defs>
            <linearGradient id="lsg1" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#e9f0ff" />
              <stop offset="0.45" stopColor="#8fb0ff" />
              <stop offset="1" stopColor="#5b3fc4" />
            </linearGradient>
          </defs>
          <polygon points="37,2 70,26 60,82 14,82 4,26" fill="url(#lsg1)" opacity="0.95" />
          <polygon points="37,2 70,26 37,38" fill="#ffffff" opacity="0.55" />
          <polygon points="37,2 4,26 37,38" fill="#bfd0ff" opacity="0.5" />
          <polygon points="37,38 70,26 60,82" fill="#2c3f9a" opacity="0.55" />
          <polygon points="37,38 4,26 14,82" fill="#7a63d6" opacity="0.45" />
          <polygon points="37,38 60,82 14,82" fill="#3b2a8f" opacity="0.4" />
        </svg>
        <h1 className="ls-logo" data-testid="title-logo">
          LODESTONE
        </h1>
        <p className="ls-tag">a generated world, waiting</p>
        <button className="ls-play" data-testid="play" onClick={start}>
          Play{SOLO ? ' (solo)' : ''}
        </button>
      </div>
      <p style={foot}>protocol v{PROTOCOL_VERSION}{SOLO ? ' · solo, no servers' : ''}</p>
    </CaveBackdrop>
  );
}

const centre: CSSProperties = { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '0 16px', textAlign: 'center', pointerEvents: 'none' };
const foot: CSSProperties = { position: 'absolute', bottom: 12, left: 0, right: 0, margin: 0, textAlign: 'center', fontSize: 12, opacity: 0.45, color: '#b9c4ff', pointerEvents: 'none' };

const TITLE_CSS = `
.ls-mark { filter: drop-shadow(0 0 18px rgba(120,150,255,.65)); margin-bottom: 4px; }
.ls-logo {
  margin: 0; font: 800 clamp(40px, 11.5vw, 124px)/1 Georgia, 'Times New Roman', serif; letter-spacing: .1em; padding-left: .1em;
  background: linear-gradient(180deg, #ffffff 0%, #d9ccff 30%, #8fa4ff 56%, #5a49d6 78%, #2fbf68 120%);
  -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 2px 0 rgba(10,8,40,.9)) drop-shadow(0 0 26px rgba(110,130,255,.55));
}
.ls-tag { margin: 6px 0 22px; letter-spacing: .32em; text-transform: uppercase; font-size: clamp(11px, 2.6vw, 15px); color: #b8c4ff; opacity: .8; text-shadow: 0 1px 8px #000; }
.ls-play {
  pointer-events: auto; cursor: pointer; padding: 13px 54px; font: 700 19px/1 Georgia, serif; letter-spacing: .24em; text-transform: uppercase; color: #eef0ff;
  background: linear-gradient(180deg, rgba(70,60,170,.85), rgba(30,26,90,.9)); border: 1px solid rgba(170,160,255,.65); border-radius: 3px;
  box-shadow: 0 0 0 1px rgba(10,8,40,.9), 0 0 28px rgba(110,100,255,.45), inset 0 1px 0 rgba(255,255,255,.25);
  transition: box-shadow .25s, transform .25s, background .25s;
}
.ls-play:hover, .ls-play:focus-visible { box-shadow: 0 0 0 1px rgba(10,8,40,.9), 0 0 42px rgba(140,130,255,.75), inset 0 1px 0 rgba(255,255,255,.35); transform: translateY(-1px); background: linear-gradient(180deg, rgba(90,78,210,.9), rgba(40,34,110,.92)); outline: none; }
@media (max-width: 520px) { .ls-play { padding: 14px 40px; } .ls-mark { width: 56px; height: auto; } }
`;
