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

import { useEffect, useRef, useState } from 'react';
import type { Site } from '@lodestone/worldgen';
import { localPlayer } from '../../state/live';
import { drawnRemotes } from '../../net/netStore';
import { hasBit, MAX_PERSONAL_PINS, PIN_COLORS, type Pin } from './events';
import { setMapOpen, useExploration } from './store';
import { mapTerrain, useMapWorld } from './world';
import { PAPER, siteGlyph } from './mapRender';

interface Hit {
  x: number;
  y: number;
  r: number;
  site?: Site;
  pin?: Pin;
}

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
  const [hover, setHover] = useState<string | null>(null);
  const [pinColor, setPinColor] = useState(0);
  const view = useRef({ zoom: 1, cx: localPlayer.pos.x, cz: localPlayer.pos.z, drag: null as null | { x: number; y: number; cx: number; cz: number; moved: boolean } });
  const hits = useRef<Hit[]>([]);

  // Free the mouse for the map.
  useEffect(() => {
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const terrain = mapTerrain();
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
          ctx.fillStyle = 'rgba(110,90,60,0.55)';
          ctx.textAlign = 'center';
          ctx.fillText('Unexplored', x0 + size / 2, y0 + size / 2);
        }
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

      // Sites.
      const order = (s: Site) => (s.kind === 'tower' ? 3 : s.category === 'settlement' ? 2 : s.kind === 'waypoint' ? 1 : 0);
      const sites = data.sites.slice().sort((a, b) => order(a) - order(b));
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
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [data, selected]);

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
    setHover(h?.site ? (h.site.name ?? h.site.kind.replace('_', ' ')) : h?.pin ? (h.pin.party ? `Party pin (${h.pin.owner})` : 'Your pin') : null);
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
    <div data-testid="map-screen" style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(10,8,6,0.82)', display: 'grid', gridTemplateColumns: '1fr 260px', font: '14px system-ui, sans-serif', color: '#2b2116' }}>
      <canvas
        ref={canvasRef}
        data-testid="map-canvas"
        style={{ width: '100%', height: '100%', display: 'block', cursor: hover ? 'pointer' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
      />
      <aside style={{ background: PAPER_CSS, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, borderLeft: '3px solid #6b5537', overflow: 'auto' }}>
        <div style={{ font: '600 20px Georgia, serif' }}>{data?.names[0] ?? 'Map'}</div>
        <div data-testid="map-revealed" style={{ fontSize: 13 }}>
          Regions revealed: {popcount(progress.revealed)} / {data?.regions.length ?? 16} · Level {progress.level} · {progress.xp.toString()} XP
        </div>
        {hover && <div style={{ fontStyle: 'italic' }}>{hover}</div>}
        {selected ? (
          <div style={{ padding: 10, background: 'rgba(255,255,255,0.35)', borderRadius: 4 }}>
            <div style={{ fontWeight: 600 }}>{selected.name ?? selected.kind.replace('_', ' ')}</div>
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
