// Title screen. Cheap on purpose (no WebGL): the 3D bundle is lazy-loaded
// behind "Play" so first paint doesn't wait for three.js.
import { useEffect } from 'react';
import { PROTOCOL_VERSION } from '@lodestone/contracts';
import { useAppStore } from '../stores/appStore';
import { SOLO } from '../config';

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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, background: 'radial-gradient(ellipse at 50% 35%, #1d2b44 0%, #0b0f14 70%)' }}>
      <h1 style={{ margin: 0, fontSize: 64, letterSpacing: 8, fontWeight: 300 }}>LODESTONE</h1>
      <p style={{ margin: 0, opacity: 0.6 }}>a generated world, waiting</p>
      <button data-testid="play" onClick={start} style={{ marginTop: 12, padding: '10px 36px', fontSize: 18, background: '#2b3a55', color: '#e6e6e6', border: '1px solid #4c6185', borderRadius: 4, cursor: 'pointer' }}>
        Play{SOLO ? ' (solo)' : ''}
      </button>
      <p style={{ position: 'fixed', bottom: 12, margin: 0, fontSize: 12, opacity: 0.4 }}>protocol v{PROTOCOL_VERSION}{SOLO ? ' · solo, no servers' : ''}</p>
    </div>
  );
}
