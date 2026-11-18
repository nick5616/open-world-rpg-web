// Playtest 5 (CR 055): the journal's Info tab. Every town you have found, with
// what it offers and where, and for each service "Mark on map" (a named pin,
// the zone names it: Interact 185) and "Guide me" (the wisp leads you there).

import { useEffect, useMemo, useState } from 'react';
import type { Site } from '@lodestone/worldgen';
import { localPlayer } from '../../state/live';
import { useExploration } from '../map/store';
import { siteName } from '../map/MapScreen';
import { useMapWorld } from '../map/world';
import { guideTo } from '../../world/guide/guideStore';
import { discoveredTowns, SERVICE_KINDS, type Service } from './townInfo';
import { whereText } from './events';
import { setJournalOpen } from './store';

const GOLD = '#ffd166';
const btn = (on = false): React.CSSProperties => ({ font: '600 12px system-ui', padding: '3px 9px', borderRadius: 4, border: `1px solid ${on ? '#e0b44c' : '#6b5a3c'}`, background: on ? '#7a5a1c' : '#2c261d', color: '#f6e7c0', cursor: 'pointer' });

export function InfoTab() {
  const towns = useMapWorld((s) => s.towns);
  const data = useMapWorld((s) => s.data);
  const discoveries = useExploration((s) => s.progress.discoveries);
  const actions = useExploration((s) => s.actions);
  const pins = useExploration((s) => s.pins);
  const [, tick] = useState(0);
  const [marked, setMarked] = useState<string | null>(null);
  // Distances follow you.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const name = useMemo(() => (s: Site) => siteName(s, data?.sites), [data]);
  const here = { x: localPlayer.pos.x, z: localPlayer.pos.z };
  const list = towns && data ? discoveredTowns(towns, data.sites, discoveries, here, name) : [];
  const isMarked = (sv: Service) => pins.some((p) => !p.party && Math.abs(p.x - sv.x) < 0.02 && Math.abs(p.z - sv.z) < 0.02);

  if (!towns || !data) return <div data-testid="journal-info" style={{ opacity: 0.7, fontSize: 13, padding: 6 }}>The land is still loading.</div>;
  return (
    <div data-testid="journal-info" style={{ height: '100%', overflowY: 'auto', paddingRight: 6 }}>
      {list.length === 0 && <div style={{ opacity: 0.7, fontSize: 13 }}>No towns found yet. Walk into one and it is written here.</div>}
      {list.map((t) => (
        <section key={t.settlement} data-testid="info-town" style={{ marginBottom: 14 }}>
          <div style={{ font: '600 18px Georgia, serif', color: '#f6e7c0' }}>{t.name}</div>
          <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>{whereText(here.x, here.z, { x: t.x, z: t.z, label: '' })}</div>
          {t.services.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>Nothing of note.</div>}
          {t.services.map((sv, i) => (
            <div key={i} data-testid="info-service" data-kind={sv.kind} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderTop: '1px solid rgba(255,209,102,0.12)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ color: GOLD, fontWeight: 600, fontSize: 13 }}>{sv.label}</span>
                <span style={{ fontSize: 12, opacity: 0.8 }}> · {sv.detail}</span>
                <span style={{ fontSize: 11, opacity: 0.55 }}> · {whereText(here.x, here.z, { x: sv.x, z: sv.z, label: '' })}</span>
              </div>
              <button
                data-testid="info-mark"
                disabled={!actions || isMarked(sv)}
                onClick={() => {
                  actions?.placeService(t.settlement, SERVICE_KINDS[sv.kind], sv.x, sv.z);
                  setMarked(`${sv.label}, ${t.name}`);
                }}
                style={btn(isMarked(sv))}
                title={isMarked(sv) ? 'Already on your map' : 'Put it on your map and compass'}
              >
                {isMarked(sv) ? 'On your map' : 'Mark on map'}
              </button>
              <button
                data-testid="info-guide"
                onClick={() => {
                  guideTo(sv.x, sv.z, `${sv.label}, ${t.name}`);
                  setJournalOpen(false);
                }}
                style={btn()}
                title="A wisp leads you there"
              >
                Guide me
              </button>
            </div>
          ))}
        </section>
      ))}
      {marked && (
        <div data-testid="info-marked" style={{ position: 'sticky', bottom: 0, fontSize: 12, color: '#b8f0a0', background: 'rgba(14,12,10,0.9)', padding: '4px 0' }}>
          Marked: {marked}
        </div>
      )}
    </div>
  );
}
