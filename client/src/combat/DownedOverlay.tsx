// Playtest 2 (new player onboarding, CR 024): the downed screen ("Downed by
// a Dewdrop Slime", where and when you come back, what you keep) and, after
// the respawn, a short line while enemies leave you alone. Text from
// downed.ts; times from the combat HUD store.

import { useEffect, useState } from 'react';
import { useCombatHud } from './store';
import { downedLines, graceLine } from './downed';

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return;
    setNow(performance.now());
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

export function DownedOverlay() {
  const until = useCombatHud((s) => s.downedUntil);
  const by = useCombatHud((s) => s.downedBy);
  const respawnAt = useCombatHud((s) => s.respawnAt);
  const graceUntil = useCombatHud((s) => s.graceUntil);
  const now = useNow(until > 0 || graceUntil > 0);
  if (until > 0) {
    const l = downedLines({ until, by, respawnAt }, now);
    return (
      <div data-testid="downed" style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, rgba(60,0,0,0.25) 0%, rgba(70,0,0,0.6) 100%)', display: 'grid', placeItems: 'center', pointerEvents: 'none', zIndex: 30 }}>
        <div style={{ textAlign: 'center', textShadow: '0 2px 6px #000', font: '15px/1.5 system-ui, sans-serif', color: '#f1e6e6' }}>
          <div style={{ font: '700 34px/1.2 system-ui, sans-serif', letterSpacing: 1 }}>{l.title}</div>
          {l.by && <div data-testid="downed-by" style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>{l.by}</div>}
          <div data-testid="downed-when" style={{ marginTop: 14 }}>{l.when}</div>
          <div data-testid="downed-keep" style={{ marginTop: 4, opacity: 0.75, fontSize: 13 }}>{l.keep}</div>
        </div>
      </div>
    );
  }
  const g = graceUntil > 0 ? graceLine(graceUntil, now) : null;
  if (!g) return null;
  return (
    <div data-testid="respawn-grace" style={{ position: 'absolute', top: '24%', left: '50%', transform: 'translateX(-50%)', padding: '5px 12px', borderRadius: 4, background: 'rgba(8,10,16,0.6)', color: '#cfe8ff', font: '600 14px/1.35 system-ui, sans-serif', textShadow: '0 1px 2px #000', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
      {g}
    </div>
  );
}
