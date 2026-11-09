// Travel to a friend (playtest 2): the channel bar ("Travelling to Bea…
// hold still"), the fade on arrival, and refusals. Centered, pointer-events
// none; mounted by SocialOverlay.
import { useEffect, useState } from 'react';
import { ensureTravelHook, useTravel } from '../travel';
import { glass } from './style';

const NOTE_MS = 3500;
const FADE_MS = 900;

export function TravelOverlay() {
  const { channel, note, fadeAt } = useTravel();
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    ensureTravelHook();
    const hook = setInterval(ensureTravelHook, 1000);
    return () => clearInterval(hook);
  }, []);
  const animating = !!channel || (note && now - note.at < NOTE_MS) || now - fadeAt < FADE_MS;
  useEffect(() => {
    if (!animating) return;
    let raf = requestAnimationFrame(function tick() {
      setNow(performance.now());
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [animating]);

  const frac = channel ? Math.min(1, (now - channel.at) / Math.max(1, channel.ms)) : 0;
  // Darken over the last third of the channel, then lift after the move.
  const fadeIn = channel ? Math.max(0, (frac - 0.66) / 0.34) : 0;
  const fadeOut = now - fadeAt < FADE_MS ? 1 - (now - fadeAt) / FADE_MS : 0;
  const dark = Math.max(fadeIn, fadeOut) * 0.85;
  const showNote = !channel && note && now - note.at < NOTE_MS;
  return (
    <>
      {dark > 0.01 && <div style={{ position: 'fixed', inset: 0, background: '#000', opacity: dark, pointerEvents: 'none', zIndex: 40 }} />}
      {channel && (
        <div data-testid="travel-channel" style={{ ...glass, position: 'fixed', left: '50%', top: '38%', transform: 'translateX(-50%)', padding: '8px 14px', pointerEvents: 'none', zIndex: 41, textAlign: 'center', fontSize: 13 }}>
          <div>Travelling to {channel.name}… hold still</div>
          <div style={{ marginTop: 6, width: 220, height: 5, background: '#0008', borderRadius: 3 }}>
            <div style={{ width: `${Math.round(frac * 100)}%`, height: 5, background: '#9fd3ff', borderRadius: 3 }} />
          </div>
        </div>
      )}
      {showNote && (
        <div data-testid="travel-note" style={{ ...glass, position: 'fixed', left: '50%', top: '38%', transform: 'translateX(-50%)', padding: '6px 12px', pointerEvents: 'none', zIndex: 41, fontSize: 13 }}>
          {note.text}
        </div>
      )}
    </>
  );
}
