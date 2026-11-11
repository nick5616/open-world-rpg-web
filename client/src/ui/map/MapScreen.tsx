// The map (M): unrevealed regions are blank paper; a region whose tower you
// climbed shows the atlas terrain. On top: what you've found (discovered
// sites, unlocked towers, activated waypoints; everything in revealed
// regions, dimmed until discovered), your pins and your party's, party
// members anywhere in the world, and you. Select an unlocked tower or
// waypoint and Travel to fast travel (the zone validates and teleports).
// Right-click drops a personal pin, Shift+right-click a party pin; clicking
// a pin removes it. Wheel zooms, drag pans.
//
// Drawn imperatively into one canvas on rAF while open (the player marker
// moves every frame; React would re-render 60 times a second for nothing).

import { drawLayerOverlay, MAP_LAYER_NAMES, MAP_LAYER_ORDER, siteOnLayer, type MapLayer } from './layers';
import { audioWorld } from '../../audio/bridge';
import { useEffect, useRef, useState } from 'react';
import type { Site } from '@lodestone/worldgen';
import { localPlayer } from '../../state/live';
import { drawnRemotes } from '../../net/netStore';
import { hasBit, MAX_PERSONAL_PINS, PIN_COLORS, type Pin } from './events';
import { setMapOpen, useExploration } from './store';
import { mapTerrain, useMapWorld } from './world';
import { anyExploredIn, currentExplored, exploredMask } from './explored';
import { PAPER, siteGlyph } from './mapRender';
// Playtest 1: quest markers and offer previews.
import { trackedQuest, useQuests } from '../quests/store';
// CR 023: discovered sealed vaults and world events in range.
import { useContent } from '../content/store';
// CR 025: signposts (yours and your party's) and your bedroll.
import { useCamps } from '../camps/store';
import { whereText } from '../quests/events';

interface Hit {
  x: number;
  y: number;
  r: number;
  site?: Site;
  pin?: Pin;
}

/** Live transform of the open map (headless scripts click sites through it). */
export const mapView: { toScreen: ((x: number, z: number) => { x: number; y: number }) | null } = { toScreen: null };

const PAPER_CSS = `rgb(${PAPER.join(',')})`;

/** Which sites the map shows and how. */
export function siteVisibility(s: Site, revealed: number, towers: Uint8Array, waypoints: Uint8Array, discoveries: Uint8Array): 'hidden' | 'dim' | 'known' | 'unlocked' {
  const unlocked = (s.kind === 'tower' && hasBit(towers, s.index)) || (s.kind === 'waypoint' && hasBit(waypoints, s.index));
  if (unlocked) return 'unlocked';
  if (hasBit(discoveries, s.index)) return 'known';
  if ((revealed >>> s.region) & 1) return 'dim';
  return 'hidden';
}

export function canFastTravel(s: Site, towers: Uint8Array, waypoints: Uint8Array): boolean {
  return (s.kind === 'tower' && hasBit(towers, s.index)) || (s.kind === 'waypoint' && hasBit(waypoints, s.index));
}

export function MapScreen() {
  const open = useExploration((s) => s.mapOpen);
  if (!open) return null;
  return <MapView />;
}

function MapView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const data = useMapWorld((s) => s.data);
  const actions = useExploration((s) => s.actions);
  const pins = useExploration((s) => s.pins);
  const [selected, setSelected] = useState<Site | null>(null);
  // CR 038: which layer the map shows ('auto' follows where you are).
  const [layerPick, setLayerPick] = useState<MapLayer | 'auto'>('auto');
  const vertical = useMapWorld((s) => s.vertical);
  const layerRef = useRef<MapLayer>(0);
  layerRef.current = layerPick === 'auto' ? (audioWorld.layer as MapLayer) : layerPick;
  const [hover, setHover] = useState<string | null>(null);
  const [pinColor, setPinColor] = useState(0);
  // Playtest 2: open on you, zoomed to your surroundings (the wheel zooms out to the world).
  const view = useRef({ zoom: 4, cx: localPlayer.pos.x || (data?.worldSize ?? 4096) / 2, cz: localPlayer.pos.z || (data?.worldSize ?? 4096) / 2, drag: null as null | { x: number; y: number; cx: number; cz: number; moved: boolean } });
  const hits = useRef<Hit[]>([]);
  const preview = useQuests((s) => s.preview);
  const tracked = useQuests((s) => trackedQuest(s));

  // Free the mouse for the map.
  useEffect(() => {
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);

  // Playtest 1: a quest preview opens the map framed on where it takes you
  // (and you). Closing the map drops the preview (QuestHud subscribes).
  useEffect(() => {
    const p = useQuests.getState().preview;
    if (p && p.markers.length && data) {
      const xs = [...p.markers.map((m) => m.x), localPlayer.pos.x];
      const zs = [...p.markers.map((m) => m.z), localPlayer.pos.z];
      const pad = Math.max(120, ...p.markers.map((m) => (m.r ?? 0) * 1.6));
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + pad * 2;
      view.current.cx = (Math.max(...xs) + Math.min(...xs)) / 2;
      view.current.cz = (Math.max(...zs) + Math.min(...zs)) / 2;
      view.current.zoom = Math.min(8, Math.max(1, data.worldSize / span));
    }
  }, [data]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const terrain = mapTerrain();
    // Playtest 2: the terrain sketch through the explored-cells mask (rebuilt when it grows).
    let sketch: HTMLCanvasElement | null = null;
    let sketchVersion = -1;
    const exploredSketch = (): HTMLCanvasElement | null => {
      const e = currentExplored();
      if (!e || !terrain) return null;
      if (sketch && sketchVersion === e.version) return sketch;
      const mask = exploredMask(e);
      if (!mask) return null;
      sketch = sketch ?? document.createElement('canvas');
      sketch.width = terrain.width;
      sketch.height = terrain.height;
      const g = sketch.getContext('2d');
      if (!g) return null;
      g.clearRect(0, 0, sketch.width, sketch.height);
      g.globalCompositeOperation = 'source-over';
      g.imageSmoothingEnabled = true;
      g.filter = 'blur(6px)';
      g.drawImage(mask, 0, 0, sketch.width, sketch.height);
      g.filter = 'none';
      g.globalCompositeOperation = 'source-in';
      g.drawImage(terrain, 0, 0);
      g.globalCompositeOperation = 'source-over';
      sketchVersion = e.version;
      return sketch;
    };
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const st = useExploration.getState();
      const { revealed, towers, waypoints, discoveries } = st.progress;
      const v = view.current;
      const side = Math.min(w, h);
      const k = (side / data.worldSize) * v.zoom;
      const sx = (x: number) => (x - v.cx) * k + w / 2;
      const sy = (z: number) => (z - v.cz) * k + h / 2;
      const out: Hit[] = [];

      ctx.fillStyle = '#1b1712';
      ctx.fillRect(0, 0, w, h);
      // Regions: terrain where revealed, paper with hatching elsewhere.
      const per = data.regionsPerEdge;
      const rs = data.worldSize / per;
      ctx.font = '600 13px Georgia, serif';
      for (let r = 0; r < per * per; r++) {
        const rx = (r % per) * rs;
        const rz = Math.floor(r / per) * rs;
        const x0 = sx(rx);
        const y0 = sy(rz);
        const size = rs * k;
        if (x0 > w || y0 > h || x0 + size < 0 || y0 + size < 0) continue;
        if ((revealed >>> r) & 1 && terrain) {
          const px = terrain.width / per;
          ctx.drawImage(terrain, (r % per) * px, Math.floor(r / per) * px, px, px, x0, y0, size, size);
        } else {
          ctx.fillStyle = PAPER_CSS;
          ctx.fillRect(x0, y0, size, size);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, y0, size, size);
          ctx.clip();
          ctx.strokeStyle = 'rgba(120,100,70,0.12)';
          ctx.lineWidth = 1;
          for (let d = -size; d < size; d += 14) {
            ctx.beginPath();
            ctx.moveTo(x0 + d, y0);
            ctx.lineTo(x0 + d + size, y0 + size);
            ctx.stroke();
          }
          ctx.restore();
          const ex = currentExplored();
          if (!ex || !anyExploredIn(ex, rx, rz, rs)) {
            ctx.fillStyle = 'rgba(110,90,60,0.55)';
            ctx.textAlign = 'center';
            ctx.fillText('Unexplored', x0 + size / 2, y0 + size / 2);
          }
        }
      }
      // Where you have walked: the terrain sketch, softly faded in at the edges.
      const sk = exploredSketch();
      if (sk) {
        ctx.save();
        ctx.globalAlpha = 0.92;
        ctx.drawImage(sk, sx(0), sy(0), data.worldSize * k, data.worldSize * k);
        ctx.restore();
      }
      // Region borders and names (names only where revealed).
      ctx.strokeStyle = 'rgba(60,45,25,0.45)';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1;
      for (let i = 0; i <= per; i++) {
        ctx.beginPath();
        ctx.moveTo(sx(i * rs), sy(0));
        ctx.lineTo(sx(i * rs), sy(data.worldSize));
        ctx.moveTo(sx(0), sy(i * rs));
        ctx.lineTo(sx(data.worldSize), sy(i * rs));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.textAlign = 'left';
      for (const reg of data.regions) {
        if (!((revealed >>> reg.index) & 1)) continue;
        const x = sx((reg.index % per) * rs) + 8;
        const y = sy(Math.floor(reg.index / per) * rs) + 20;
        ctx.fillStyle = 'rgba(40,28,14,0.8)';
        ctx.fillText(reg.name, x, y);
      }

      // CR 038: the layer shown (archipelagos over a veil; caverns under the darkened land).
      const showLayer = layerPick === 'auto' ? (audioWorld.layer as MapLayer) : layerPick;
      drawLayerOverlay(ctx, vertical, showLayer, sx, sy, k, w, h, (i) => (i >= 0 && i < data.sites.length && siteVisibility(data.sites[i], revealed, towers, waypoints, discoveries) !== 'hidden' ? data.sites[i].name : null));

      // Sites.
      const order = (s: Site) => (s.kind === 'tower' ? 3 : s.category === 'settlement' ? 2 : s.kind === 'waypoint' ? 1 : 0);
      const sites = data.sites.filter((s) => siteOnLayer(s, showLayer)).sort((a, b) => order(a) - order(b));
      for (const s of sites) {
        const vis = siteVisibility(s, revealed, towers, waypoints, discoveries);
        if (vis === 'hidden') continue;
        const x = sx(s.x);
        const y = sy(s.z);
        if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
        drawSite(ctx, s, x, y, vis, k, selected?.index === s.index);
        out.push({ x, y, r: 10, site: s });
        if ((vis === 'known' || vis === 'unlocked') && s.name && (s.kind === 'tower' || s.category === 'settlement' || v.zoom > 2)) {
          ctx.font = '12px Georgia, serif';
          ctx.fillStyle = 'rgba(30,20,10,0.9)';
          ctx.textAlign = 'center';
          ctx.fillText(s.name, x, y + 20);
        }
      }

      // Pins.
      for (const p of st.pins) {
        const x = sx(p.x);
        const y = sy(p.z);
        drawPin(ctx, x, y, PIN_COLORS[p.color % PIN_COLORS.length], p.party ? (p.owner[0] ?? '?').toUpperCase() : '');
        out.push({ x, y: y - 12, r: 10, pin: p });
      }

      // Playtest 1: quest markers (every active quest's current step; the
      // tracked one in gold) and a preview of where an offer would take you.
      const qs = useQuests.getState();
      const placed: { x: number; y: number }[] = [];
      for (const q of qs.log.quests) {
        const tracked = q.id === (trackedQuest(qs)?.id ?? -1);
        for (const m of q.markers) drawQuestMarker(ctx, sx(m.x), sy(m.z), (m.r ?? 0) * k, tracked ? '#ffd166' : '#e8a33d', tracked ? m.label : '', tracked ? 1 : 0.6, false, placed);
      }
      if (qs.preview) for (const m of qs.preview.markers) drawQuestMarker(ctx, sx(m.x), sy(m.z), (m.r ?? 0) * k, '#7fe3ff', m.label, 1, true, placed);
      // CR 023: sealed vaults you found (a keyhole) and world events in range (a red circle).
      const cs = useContent.getState();
      for (const v of cs.sync.vaults) drawVault(ctx, sx(v.x), sy(v.z), v.name);
      for (const e of Object.values(cs.events)) if (e.phase === 1) drawQuestMarker(ctx, sx(e.x), sy(e.z), Math.max(6, e.r * k), '#ff7b54', e.name, 1, false, placed);
      const camp = useCamps.getState().mine;
      for (const m of camp.markers) drawCamp(ctx, sx(m.x), sy(m.z), m.mine ? m.label : `${m.label} (${m.owner})`, m.mine ? '#ffb35a' : '#e9c46a');
      if (camp.spawn && !camp.markers.some((m) => m.mine && Math.hypot(m.x - camp.spawn![0], m.z - camp.spawn![1]) < 25)) drawCamp(ctx, sx(camp.spawn[0]), sy(camp.spawn[1]), 'Your bedroll', '#ffb35a');

      // Party members (drawn remotes in my party: the party ring keeps them at any distance).
      if (st.partyId) {
        for (const r of drawnRemotes.views) {
          if (r.partyId !== st.partyId) continue;
          const x = sx(r.x);
          const y = sy(r.z);
          ctx.fillStyle = '#4cc9f0';
          ctx.strokeStyle = '#08202a';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.font = '600 12px system-ui, sans-serif';
          ctx.fillStyle = '#08202a';
          ctx.textAlign = 'center';
          ctx.fillText(r.name, x, y - 10);
        }
      }

      // You: an arrow along the view direction (yaw 0 faces -z = up).
      const px = sx(localPlayer.pos.x);
      const py = sy(localPlayer.pos.z);
      const fx = -Math.sin(localPlayer.yaw);
      const fz = -Math.cos(localPlayer.yaw);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.atan2(fz, fx) + Math.PI / 2);
      ctx.fillStyle = '#ffdf6b';
      ctx.strokeStyle = '#2a1d00';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(8, 9);
      ctx.lineTo(0, 4);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      hits.current = out;
      mapView.toScreen = (x: number, z: number) => {
        const r = canvas.getBoundingClientRect();
        return { x: r.left + sx(x), y: r.top + sy(z) };
      };
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      mapView.toScreen = null;
    };
  }, [data, selected, layerPick, vertical]);

  const toWorld = (cx: number, cy: number) => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const v = view.current;
    const k = (Math.min(r.width, r.height) / (data?.worldSize ?? 4096)) * v.zoom;
    return { x: (cx - r.left - r.width / 2) / k + v.cx, z: (cy - r.top - r.height / 2) / k + v.cz, lx: cx - r.left, ly: cy - r.top };
  };
  const hitAt = (lx: number, ly: number) => {
    let best: Hit | null = null;
    let bd = Infinity;
    for (const h of hits.current) {
      const d = Math.hypot(h.x - lx, h.y - ly);
      // Pins win ties: they sit on top.
      if (d <= h.r && (d < bd || (h.pin && best?.site))) {
        best = h;
        bd = d;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    view.current.drag = { x: e.clientX, y: e.clientY, cx: view.current.cx, cz: view.current.cz, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const v = view.current;
    const d = v.drag;
    if (d) {
      const k = (Math.min(canvasRef.current!.clientWidth, canvasRef.current!.clientHeight) / (data?.worldSize ?? 4096)) * v.zoom;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
      v.cx = d.cx - (e.clientX - d.x) / k;
      v.cz = d.cz - (e.clientY - d.y) / k;
    }
    const w = toWorld(e.clientX, e.clientY);
    const h = hitAt(w.lx, w.ly);
    setHover(h?.site ? siteName(h.site, data?.sites) : h?.pin ? (h.pin.party ? `Party pin (${h.pin.owner})` : 'Your pin') : null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = view.current.drag;
    view.current.drag = null;
    if (e.button !== 0 || d?.moved) return;
    const w = toWorld(e.clientX, e.clientY);
    const h = hitAt(w.lx, w.ly);
    if (h?.pin) {
      actions?.clearPin(h.pin);
      return;
    }
    setSelected(h?.site ?? null);
  };
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    if (!data || w.x < 0 || w.z < 0 || w.x >= data.worldSize || w.z >= data.worldSize) return;
    actions?.setPin(w.x, w.z, e.shiftKey, pinColor);
  };
  const onWheel = (e: React.WheelEvent) => {
    const v = view.current;
    const before = toWorld(e.clientX, e.clientY);
    v.zoom = Math.min(8, Math.max(1, v.zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
    const after = toWorld(e.clientX, e.clientY);
    v.cx += before.x - after.x;
    v.cz += before.z - after.z;
  };

  const progress = useExploration((s) => s.progress);
  const personal = pins.filter((p) => !p.party).length;
  const travel = selected && canFastTravel(selected, progress.towers, progress.waypoints);

  return (
    <div data-testid="map-screen" data-ui-panel style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(10,8,6,0.82)', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', font: '14px system-ui, sans-serif', color: '#2b2116' }}>
      {/* The canvas sits absolutely in its cell: its pixel size must never feed back into the grid's column width. */}
      <div style={{ position: 'relative', minWidth: 0, overflow: 'hidden' }}>
      {vertical && (
        <div data-testid="map-layers" style={{ position: 'absolute', top: 12, left: 12, zIndex: 2, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(['auto', ...MAP_LAYER_ORDER] as const).map((l) => (
            <button
              key={String(l)}
              data-testid={`map-layer-${l}`}
              onClick={() => setLayerPick(l)}
              onMouseDown={(e) => e.stopPropagation()}
              style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #6b5537', cursor: 'pointer', font: '600 12px Georgia, serif', textAlign: 'left', background: layerPick === l ? '#f4ecd8' : 'rgba(40,30,20,0.75)', color: layerPick === l ? '#2b2116' : '#f4ecd8' }}
            >
              {l === 'auto' ? `Here (${MAP_LAYER_NAMES[audioWorld.layer] ?? 'Surface'})` : MAP_LAYER_NAMES[l]}
            </button>
          ))}
        </div>
      )}
      <canvas
        ref={canvasRef}
        data-testid="map-canvas"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: hover ? 'pointer' : 'grab' }}
        onPointerDown={onPointerDown}
        // The game grabs pointer lock on a mousedown on ANY canvas (input/useMouseLook.ts);
        // locking onto the map would swallow every later click, including the Travel button.
        onMouseDown={(e) => e.stopPropagation()}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
      />
      </div>
      <aside style={{ background: PAPER_CSS, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, borderLeft: '3px solid #6b5537', overflow: 'auto' }}>
        <div style={{ font: '600 20px Georgia, serif' }}>{data?.names[0] ?? 'Map'}</div>
        <div data-testid="map-revealed" style={{ fontSize: 13 }}>
          Regions revealed: {popcount(progress.revealed)} / {data?.regions.length ?? 16} · Level {progress.level} · {progress.xp.toString()} XP
        </div>
        {hover && <div style={{ fontStyle: 'italic' }}>{hover}</div>}
        {preview ? (
          <div data-testid="map-quest-preview" style={{ padding: 10, background: 'rgba(127,227,255,0.18)', border: '1px dashed #2b7a8f', borderRadius: 4 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.75 }}>{preview.from === 'quest' ? 'Quest' : 'Where it takes you'}</div>
            <div style={{ fontWeight: 600, margin: '2px 0 6px' }}>{preview.title}</div>
            {preview.markers.map((m, i) => (
              <div key={i} style={{ fontSize: 12 }}>
                ◈ {m.label}: {whereText(localPlayer.pos.x, localPlayer.pos.z, m)}
                {m.r ? ` (area ~${Math.round(m.r)} m)` : ''}
              </div>
            ))}
          </div>
        ) : tracked ? (
          <div data-testid="map-quest" style={{ padding: 10, background: 'rgba(255,209,102,0.18)', borderLeft: '3px solid #c58f12', borderRadius: 4 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.75 }}>Tracked quest</div>
            <div style={{ fontWeight: 600 }}>{tracked.title}</div>
            <div style={{ fontSize: 12, marginTop: 2 }}>{tracked.text}</div>
            {tracked.markers.map((m, i) => (
              <div key={i} style={{ fontSize: 12, opacity: 0.85 }}>
                ◆ {m.label}: {whereText(localPlayer.pos.x, localPlayer.pos.z, m)}
              </div>
            ))}
          </div>
        ) : null}
        {selected ? (
          <div style={{ padding: 10, background: 'rgba(255,255,255,0.35)', borderRadius: 4 }}>
            <div style={{ fontWeight: 600 }}>{siteName(selected, data?.sites)}</div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>{selected.kind.replace('_', ' ')} · {data?.regions[selected.region]?.name}</div>
            {travel ? (
              <button data-testid="map-travel" onClick={() => { actions?.fastTravel(selected.index); setMapOpen(false); }} disabled={!actions}>
                Fast travel here
              </button>
            ) : (
              <div style={{ fontSize: 12 }}>{selected.kind === 'tower' ? 'Climb this tower to unlock fast travel.' : selected.kind === 'waypoint' ? 'Touch this waypoint stone to unlock it.' : ''}</div>
            )}
          </div>
        ) : null}
        <div style={{ fontSize: 12 }}>
          Pins: {personal} / {MAX_PERSONAL_PINS} · colour{' '}
          {PIN_COLORS.map((c, i) => (
            <button key={c} onClick={() => setPinColor(i)} title={`pin colour ${i}`} style={{ width: 16, height: 16, padding: 0, marginRight: 3, background: c, border: i === pinColor ? '2px solid #222' : '1px solid #555', borderRadius: 3, verticalAlign: 'middle' }} />
          ))}
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.5 }}>
          <li>Click an unlocked tower or waypoint, then Fast travel</li>
          <li>Right-click: drop a pin · Shift+right-click: party pin</li>
          <li>Click a pin to remove it</li>
          <li>Wheel: zoom · drag: pan · M or Esc: close</li>
        </ul>
        {!actions && <div style={{ fontSize: 12, color: '#7a2e12' }}>Offline: progress, pins and fast travel need the server.</div>}
      </aside>
    </div>
  );
}

/** Display name: its own, else (settlement waypoints) the linked settlement's, else its kind. */
export function siteName(s: Site, sites?: Site[]): string {
  return s.name ?? (s.link >= 0 ? sites?.[s.link]?.name : null) ?? s.kind.replace('_', ' ');
}

function popcount(v: number): number {
  let n = 0;
  for (let x = v >>> 0; x; x &= x - 1) n++;
  return n;
}

function drawSite(ctx: CanvasRenderingContext2D, s: Site, x: number, y: number, vis: 'dim' | 'known' | 'unlocked', k: number, selected: boolean) {
  const g = siteGlyph(s);
  ctx.globalAlpha = vis === 'dim' ? 0.45 : 1;
  ctx.fillStyle = g.color;
  ctx.strokeStyle = '#1d140a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  switch (g.shape) {
    case 'tower':
      ctx.moveTo(x - 5, y + 8);
      ctx.lineTo(x - 3, y - 8);
      ctx.lineTo(x + 3, y - 8);
      ctx.lineTo(x + 5, y + 8);
      ctx.closePath();
      break;
    case 'waypoint':
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x + 5, y);
      ctx.lineTo(x, y + 8);
      ctx.lineTo(x - 5, y);
      ctx.closePath();
      break;
    case 'town': {
      const r = Math.max(4, Math.min(14, s.radius * k * 0.5));
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    }
    case 'cave':
      ctx.arc(x, y, 5, Math.PI, 0);
      ctx.lineTo(x + 5, y + 4);
      ctx.lineTo(x - 5, y + 4);
      ctx.closePath();
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 ? 2.5 : 6;
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      ctx.closePath();
      break;
    case 'camp':
      ctx.moveTo(x - 5, y + 5);
      ctx.lineTo(x, y - 5);
      ctx.lineTo(x + 5, y + 5);
      ctx.closePath();
      break;
    default:
      ctx.rect(x - 4, y - 4, 8, 8);
  }
  ctx.fill();
  ctx.stroke();
  if (vis === 'unlocked') {
    ctx.strokeStyle = '#ffe28a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (selected) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

/** A quest marker: an area circle (rPx > 0) with a centre diamond, or a point diamond. */
export function drawQuestMarker(ctx: CanvasRenderingContext2D, x: number, y: number, rPx: number, color: string, label: string, alpha: number, dashed: boolean, placed: { x: number; y: number }[] = []) {
  ctx.save();
  ctx.globalAlpha = alpha;
  if (rPx > 4) {
    ctx.fillStyle = color + '33';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(x, y, rPx, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = color;
  ctx.strokeStyle = '#1d140a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - 9);
  ctx.lineTo(x + 6, y);
  ctx.lineTo(x, y + 9);
  ctx.lineTo(x - 6, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#1d140a';
  ctx.font = '800 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('!', x, y + 4);
  if (label) {
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,248,230,0.85)';
    // Stack labels that would overlap one already drawn this frame.
    let ly = y - 14;
    while (placed.some((p) => Math.abs(p.x - x) < 90 && Math.abs(p.y - ly) < 13)) ly -= 14;
    placed.push({ x, y: ly });
    ctx.strokeText(label, x, ly);
    ctx.fillStyle = '#2b1d08';
    ctx.fillText(label, x, ly);
  }
  ctx.restore();
}

function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, letter: string) {
  ctx.fillStyle = color;
  ctx.strokeStyle = '#1d140a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - 8, y - 10, x - 8, y - 20, x, y - 20);
  ctx.bezierCurveTo(x + 8, y - 20, x + 8, y - 10, x, y);
  ctx.fill();
  ctx.stroke();
  if (letter) {
    ctx.fillStyle = '#1d140a';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(letter, x, y - 10);
  }
}

/** A discovered sealed vault (CR 023): a dark stone square with a gold keyhole. */
export function drawVault(ctx: CanvasRenderingContext2D, x: number, y: number, name: string) {
  ctx.save();
  ctx.fillStyle = '#3a332a';
  ctx.strokeStyle = '#e8c47a';
  ctx.lineWidth = 1.5;
  ctx.fillRect(x - 6, y - 6, 12, 12);
  ctx.strokeRect(x - 6, y - 6, 12, 12);
  ctx.fillStyle = '#e8c47a';
  ctx.beginPath();
  ctx.arc(x, y - 1.5, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(x - 1, y - 1, 2, 5);
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.strokeText(name, x, y + 17);
  ctx.fillText(name, x, y + 17);
  ctx.restore();
}

/** A camp signpost or your bedroll (CR 025): a small tent with its name. */
export function drawCamp(ctx: CanvasRenderingContext2D, x: number, y: number, name: string, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#2a1d10';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - 8);
  ctx.lineTo(x + 7, y + 5);
  ctx.lineTo(x - 7, y + 5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#2a1d10';
  ctx.fillRect(x - 1.5, y, 3, 5);
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.strokeText(name, x, y + 17);
  ctx.fillStyle = color;
  ctx.fillText(name, x, y + 17);
  ctx.restore();
}
