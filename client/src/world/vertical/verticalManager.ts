// VerticalManager (CR 038): the sky archipelagos, the Underground and the
// Depths in the browser.
//
// - Streaming: per layer a quadtree over the layer's domain (the chunks a
//   feature reaches): tiles split by distance (LOD 0 = 1 m near you, up to
//   LOD 4 = 16 m spacing for islands kilometres away, the skyline), built and
//   meshed in the generation workers (`layer` jobs). LOD 0 lattices go to the
//   runtime's VerticalTileStore, which collision reads first. Islands are
//   always streamed (they are the skyline); the Underground and the Depths
//   while you are in them or near one of their openings.
// - Look: layer rock/island materials with the baked glow, glowing water and
//   lava, decorations (decoMeshes.ts), clouds under every archipelago, wind
//   columns. Lighting by layer is WorldScene's: this reports where you are
//   (layer, chamber, how deep in the sky) and lends its light emitters to
//   the cave light pool.

import * as THREE from 'three';
import { PALACE } from '@lodestone/contracts';
import { usePalace } from '../palace/palaceStore';
import { PalaceViews } from '../palace/PalaceViews';
import { RaceRings, useRace } from './race';
import { SkyLife } from './skyLife';
import { palaceLocal, palaceSites, type PalaceSite } from '../palace/palaceSites';
import { chamberAt, inSkyBand, LAYER_DEPTHS, LAYER_SKY, LAYER_UNDER, type VerticalWorld } from '@lodestone/worldgen';
import type { WorldRuntime } from '../core/runtime';
import type { ResultMsg } from '../core/protocol';
import type { LayerMeshData } from './layerMesh';
import { buildDecos, type LightEmitter } from './decoMeshes';
import { caveWaterMaterial, islandMaterial, lavaMaterial, layerRockMaterial, verticalUniforms } from './verticalMaterials';
import { useVerticalHud } from './VerticalHud';
import { dwarfSway } from './dwarfDecos';
import { CALM, flashProfile, prefersReducedMotion } from '../../combat/flashSafety';
import { DECO_INTERACT, DW, dwarfRuntime, INTERACT_CHEST, INTERACT_TABLET } from './dwarfKinds';
import { chestCooling } from './events';
import { localPlayer } from '../../state/live';

interface Tile {
  key: string;
  layer: number;
  cx: number;
  cz: number;
  lod: number;
  state: 'pending' | 'ready' | 'empty';
  mesh: THREE.Mesh | null;
  water: THREE.Mesh | null;
  used: number;
}

/** Split distance of a tile at lod l: (64 * 2^l m) * factor. */
const SPLIT: Record<number, number> = { 1: 2.0, 2: 1.3, 3: 1.3 };
/** How far each layer draws (m). */
const RANGE: Record<number, number> = { 1: 6000, 2: 650, 3: 600 };
/** Coarsest lod a layer uses. */
const MAX_LOD: Record<number, number> = { 1: 5, 2: 4, 3: 4 };

export class VerticalManager {
  readonly group = new THREE.Group();
  /** Where the player is: 0 surface, 1 sky, 2 Underground, 3 Depths. */
  layer = 0;
  /** 0..1 eased: in the Depths (red air, heat). */
  depths = 0;
  /** 0..1 eased: in a vast cavern (blue haze, huge reverb). */
  cavern = 0;
  /** 0..1 eased: high in the sky over an archipelago (wind, bright air). */
  sky = 0;
  /** Chamber the player is in (or null) and its size: audio reverb, HUD names. */
  chamber: { kind: number; radius: number; site: number; layer: number } | null = null;
  readonly stats = { tiles: 0, pending: 0, built: 0, buildMs: 0, maxMs: 0, tris: 0 };

  private readonly v: VerticalWorld;
  private readonly tiles = new Map<string, Tile>();
  private readonly rock = layerRockMaterial(false);
  private readonly deepRock = layerRockMaterial(true);
  private readonly island = islandMaterial();
  private readonly water = caveWaterMaterial();
  private readonly lava = lavaMaterial();
  private readonly decos: ReturnType<typeof buildDecos>;
  private readonly layerGroups: THREE.Group[];
  /** Domain mips per layer: mip[l][lod] = Uint8Array over (64 >> lod)^2 cells, 1 if any domain chunk inside. */
  private readonly mips: Uint8Array[][] = [];
  private frame = 0;
  private readonly palaces: PalaceSite[];
  private readonly palaceViews: PalaceViews;
  private readonly raceRings = new RaceRings();
  private skyLife: SkyLife | null = null;
  private readonly shrines: { x: number; y: number; z: number; size: number; aux: number }[]; // CR 044: Depths demon shrines (Interact 153)
  private readonly activities: { x: number; y: number; z: number; id: bigint }[];
  private readonly interactives: { i: number; x: number; y: number; z: number; kind: number }[] = [];
  private emittersNear: LightEmitter[] = [];

  /** Low tier: shorter ranges, coarser tiles (Graphics "low" stays playable). */
  private low = false;
  setLow(low: boolean): void {
    this.low = low;
  }

  constructor(private readonly runtime: WorldRuntime) {
    this.v = runtime.vertical!;
    this.layerGroups = [0, 1, 2, 3].map(() => new THREE.Group());
    for (const g of this.layerGroups) this.group.add(g);
    this.decos = buildDecos(this.v);
    this.palaces = palaceSites(this.v);
    this.palaceViews = new PalaceViews(this.palaces);
    this.layerGroups[1].add(this.palaceViews.group, this.raceRings.group);
    this.skyLife = new SkyLife(this.v, this.low);
    this.layerGroups[1].add(this.skyLife.group);
    this.decos.emitters.push(...this.palaceViews.emitters());
    this.shrines = this.v.decos.filter((d) => d.kind === 24);
    this.v.decos.forEach((d, i) => {
      if ((d.flags & DECO_INTERACT) !== 0 && d.layer === LAYER_UNDER && (d.kind === DW.chest || d.kind === DW.tablet)) this.interactives.push({ i, x: d.x, y: d.y, z: d.z, kind: d.kind });
    });
    dwarfRuntime.openChest = (i) => this.decos.dwarf.openChest(i);
    dwarfRuntime.siteName = (s) => runtime.data.sites[s]?.name ?? null;
    dwarfRuntime.openedAt.clear();
    dwarfRuntime.found.clear();
    this.activities = (runtime.towns?.props ?? []).filter((p) => p.kind === 31).map((p) => ({ x: p.x, y: p.y, z: p.z, id: p.id }));
    this.decos.groups.forEach((g, i) => this.layerGroups[i].add(g));
    for (let layer = 1; layer <= 3; layer++) {
      const levels: Uint8Array[] = [];
      let n = 64;
      let cur = new Uint8Array(64 * 64);
      for (let k = 0; k < 64 * 64; k++) cur[k] = (this.v.domain[layer - 1][k >> 3] >> (k & 7)) & 1;
      levels.push(cur);
      while (n > 1) {
        const m = n >> 1;
        const next = new Uint8Array(m * m);
        for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) next[j * m + i] = cur[2 * j * n + 2 * i] | cur[2 * j * n + 2 * i + 1] | cur[(2 * j + 1) * n + 2 * i] | cur[(2 * j + 1) * n + 2 * i + 1];
        levels.push(next);
        cur = next;
        n = m;
      }
      this.mips[layer] = levels;
    }
    this.group.name = 'vertical';
  }

  /** Materials the CSM should shadow (islands and their decorations). */
  sunMaterials(): THREE.Material[] {
    return [this.island, ...this.decos.sunMaterials, ...this.palaceViews.sunMaterials];
  }

  /** Programs to warm up (WorldScene's shader warm-up). */
  warmObjects(): THREE.Object3D[] {
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(24 * 4), 4));
    g.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(24), 1));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
    return [this.rock, this.deepRock, this.island, this.water, this.lava].map((m) => new THREE.Mesh(g, m));
  }

  /** The light emitters near the camera for the cave light pool. */
  lightEmitters(): readonly LightEmitter[] {
    return this.emittersNear;
  }

  private domainAt(layer: number, cx: number, cz: number, lod: number): boolean {
    const n = 64 >> lod;
    const i = cx >> lod;
    const j = cz >> lod;
    if (i < 0 || j < 0 || i >= n || j >= n) return false;
    return this.mips[layer][lod][j * n + i] === 1;
  }

  /** Layers to stream from where the player is. */
  private activeLayers(feet: { x: number; y: number; z: number }): number[] {
    const out = [LAYER_SKY];
    const near = (list: { x: number; z: number }[], r: number) => list.some((o) => (o.x - feet.x) ** 2 + (o.z - feet.z) ** 2 < r * r);
    if (this.layer === LAYER_UNDER || near(this.v.surfaceOpenings, 320)) out.push(LAYER_UNDER);
    if (this.layer === LAYER_DEPTHS || (this.layer === LAYER_UNDER && near(this.v.gateOpenings, 420))) out.push(LAYER_DEPTHS);
    if (this.layer === LAYER_DEPTHS && near(this.v.gateOpenings, 600) && !out.includes(LAYER_UNDER)) out.push(LAYER_UNDER);
    return out;
  }

  private select(layer: number, cam: THREE.Vector3, out: { layer: number; cx: number; cz: number; lod: number; d: number }[]): void {
    const range = RANGE[layer] * (this.low ? 0.6 : 1);
    const maxLod = MAX_LOD[layer];
    const walk = (cx: number, cz: number, lod: number) => {
      if (!this.domainAt(layer, cx, cz, lod)) return;
      const size = 64 << lod;
      const x0 = cx * 64;
      const z0 = cz * 64;
      const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + size));
      const dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + size));
      const d = Math.hypot(dx, dz);
      if (d > range) return;
      const split = size * (SPLIT[layer] ?? 1.6) * (this.low ? 0.7 : 1);
      if (lod > maxLod || (lod > 0 && d < split)) {
        const h = 1 << (lod - 1);
        walk(cx, cz, lod - 1);
        walk(cx + h, cz, lod - 1);
        walk(cx, cz + h, lod - 1);
        walk(cx + h, cz + h, lod - 1);
        return;
      }
      out.push({ layer, cx, cz, lod, d });
    };
    walk(0, 0, 6);
  }

  update(camera: THREE.Camera, dt: number, now: number, feet: { x: number; y: number; z: number }): void {
    this.frame++;
    verticalUniforms.uTime.value += dt;
    this.palaceViews.update(camera, dt, feet);
    this.raceRings.update(now / 1000);
    if (this.skyLife) {
      this.skyLife.group.visible = !this.low; // the low tier keeps the sky empty
      if (!this.low) this.skyLife.update(now / 1000, camera.position);
    }
    const vg = this.runtime.verticalGround!;
    const layer = vg.layerAt(feet.x, feet.y, feet.z);
    this.layer = layer === 0 && inSkyBand(this.v, feet.x, feet.y, feet.z) ? LAYER_SKY : layer;
    const ease = Math.min(1, dt * 1.4);
    this.depths += ((this.layer === LAYER_DEPTHS ? 1 : 0) - this.depths) * ease;
    const ch = this.layer === LAYER_UNDER || this.layer === LAYER_DEPTHS ? chamberAt(this.v, this.layer, feet.x, feet.z, 1.0) : null;
    this.chamber = ch ? { kind: ch.kind, radius: Math.max(ch.rx, ch.rz), site: ch.site, layer: ch.layer } : null;
    this.cavern += ((ch ? 1 : this.layer === LAYER_UNDER ? 0.25 : 0) - this.cavern) * ease;
    this.sky += ((this.layer === LAYER_SKY ? 1 : 0) - this.sky) * ease;

    // Stream.
    const cam = camera.position;
    const want: { layer: number; cx: number; cz: number; lod: number; d: number }[] = [];
    for (const l of this.activeLayers(feet)) this.select(l, cam, want);
    const pool = this.runtime.pool;
    const wanted = new Set<string>();
    for (const w of want) {
      const key = `vt:${w.layer}:${w.cx}:${w.cz}:${w.lod}`;
      wanted.add(key);
      let t = this.tiles.get(key);
      if (!t) {
        t = { key, layer: w.layer, cx: w.cx, cz: w.cz, lod: w.lod, state: 'pending', mesh: null, water: null, used: now };
        this.tiles.set(key, t);
        const tile = t;
        // Near tiles first; the player's own layer before the skyline.
        const pri = w.d + (w.layer === this.layer ? 0 : 400) + w.lod * 30;
        pool
          .submit(key, { type: 'layer', layer: w.layer, cx: w.cx, cz: w.cz, lod: w.lod }, pri)
          .then((r) => this.onResult(tile, r))
          .catch((err) => {
            console.warn('[vertical] layer tile failed', err);
            tile.state = 'empty';
          });
      }
      t.used = now;
    }
    // Visible: wanted tiles that are ready, plus a ready ancestor standing in for each pending one.
    const visible = new Set<Tile>();
    for (const w of want) {
      const t = this.tiles.get(`vt:${w.layer}:${w.cx}:${w.cz}:${w.lod}`)!;
      if (t.state === 'ready') {
        visible.add(t);
        continue;
      }
      for (let lod = w.lod + 1; lod <= 6; lod++) {
        const s = 1 << lod;
        const a = this.tiles.get(`vt:${w.layer}:${Math.floor(w.cx / s) * s}:${Math.floor(w.cz / s) * s}:${lod}`);
        if (a && a.state === 'ready') {
          visible.add(a);
          break;
        }
      }
    }
    let tris = 0;
    for (const t of this.tiles.values()) {
      const on = visible.has(t);
      if (t.mesh) {
        t.mesh.visible = on;
        if (on) tris += (t.mesh.geometry.index?.count ?? 0) / 3;
      }
      if (t.water) t.water.visible = on;
    }
    // Forget tiles neither wanted nor shown for a while.
    if (this.frame % 30 === 0) {
      for (const [k, t] of this.tiles) {
        if (wanted.has(k) || visible.has(t) || now - t.used < 4000) continue;
        if (t.state === 'pending') {
          pool.cancel(k);
          if (t.state === 'pending') continue;
        }
        this.dropTile(t);
        this.tiles.delete(k);
      }
    }
    this.stats.tiles = visible.size;
    this.stats.pending = [...this.tiles.values()].filter((t) => t.state === 'pending').length;
    this.stats.tris = tris;

    // Layer visibility of decorations: the sky always; caverns and the Depths when streamed.
    const act = this.activeLayers(feet);
    this.layerGroups[2].visible = act.includes(LAYER_UNDER);
    this.layerGroups[3].visible = act.includes(LAYER_DEPTHS);
    // Emitters near the camera (refreshed a few times a second); the HUD store.
    if (this.frame % 10 === 0) {
      dwarfSway.uSwayAmp.value = flashProfile() === CALM || prefersReducedMotion() ? 0 : 1; // steady under reduce flashing / reduced motion
      this.hud(feet);
      this.emittersNear = this.decos.emitters.filter((e) => (e.layer === this.layer || (e.layer === 0 && this.layer === 0)) && (e.x - cam.x) ** 2 + (e.y - cam.y) ** 2 + (e.z - cam.z) ** 2 < 90 * 90);
    }
  }

  private hud(feet: { x: number; y: number; z: number }): void {
    const data = this.runtime.data;
    let place: string | null = null;
    if (this.chamber && this.chamber.site !== 0xffff) place = data.sites[this.chamber.site]?.name ?? null;
    if (this.layer === LAYER_SKY) {
      for (const a of this.v.archs) if ((feet.x - a.x) ** 2 + (feet.z - a.z) ** 2 < (a.r + 220) ** 2) place = data.sites[a.site]?.name ?? null;
    }
    // A fall that would hurt: fast, with the ground far below (the zone's fall damage starts at 18 m/s).
    const vg = this.runtime.verticalGround!;
    let falling = false;
    let dropM = 0;
    if (localPlayer.mode === 'air' && localPlayer.vel.y < -16) {
      dropM = feet.y - vg.floorAt(feet.x, feet.y, feet.z);
      falling = dropM > 25;
    }
    let lift = false;
    for (const u of this.v.updrafts) {
      if (u.kind !== 1) continue;
      if ((feet.x - u.x) ** 2 + (feet.z - u.z) ** 2 < 16 * 16 && feet.y < u.bottom + 30) lift = true;
    }
    const heat = this.layer === LAYER_DEPTHS && this.v.chambers.some((c) => c.layer === LAYER_DEPTHS && c.lake > -9000 && (feet.x - c.x) ** 2 + (feet.z - c.z) ** 2 < (Math.max(c.rx, c.rz) * c.lakeE + 25) ** 2);
    // The follow-ups' doors: a sky palace's gate, a sky town's activity spot.
    let use: { kind: 150 | 151 | 152 | 153 | 170 | 171; id: bigint; label: string } | null = null;
    if (this.layer === LAYER_UNDER) {
      // CR 043: chests and lore tablets in the Underground (the descriptor index is the target).
      for (const it of this.interactives) {
        if ((feet.x - it.x) ** 2 + (feet.z - it.z) ** 2 < 6.25 && Math.abs(feet.y - it.y) < 3) {
          if (it.kind === DW.chest) {
            if (!chestCooling(it.i)) use = { kind: INTERACT_CHEST, id: BigInt(it.i), label: 'Open chest' };
          } else use = { kind: INTERACT_TABLET, id: BigInt(it.i), label: 'Read tablet' };
        }
      }
    }
    // Playtest 6 polish: leaving the sky (a fall, a teleport, a fast travel) leaves the palace too; the
    // palace panel stayed up over the ground because only the sky layer asked.
    if (this.layer !== LAYER_SKY && usePalace.getState().near) usePalace.setState({ near: false });
    if (this.layer === LAYER_SKY) {
      use = this.palacePrompt(feet);
      for (const p of this.activities) {
        if ((feet.x - p.x) ** 2 + (feet.z - p.z) ** 2 < 36 && Math.abs(feet.y - p.y) < 4) use = { kind: 151, id: p.id, label: useRace.getState().phase === 'armed' || useRace.getState().phase === 'running' ? 'Stop the glide ring race' : 'Glide Ring Race: start' };
      }
    }
    if (this.layer === LAYER_DEPTHS) {
      for (const d of this.shrines) {
        if ((feet.x - d.x) ** 2 + (feet.z - d.z) ** 2 < (d.size + 9) ** 2 && Math.abs(feet.y - d.y) < 8) use = { kind: 153, id: BigInt(d.aux), label: 'Cleanse the demon shrine' };
      }
    }
    const s = useVerticalHud.getState();
    const useSame = (s.use === null && use === null) || (s.use !== null && use !== null && s.use.kind === use.kind && s.use.id === use.id);
    if (s.layer !== this.layer || s.place !== place || s.falling !== falling || s.lift !== lift || s.heat !== heat || Math.abs(s.dropM - dropM) > 5 || !useSame) useVerticalHud.setState({ layer: this.layer, place, falling, dropM, lift, heat, use });
  }

  /** CR 044: the palace's doors (outside, in front of the gate), its wards and its chest. */
  private palacePrompt(feet: { x: number; y: number; z: number }): { kind: 150 | 152; id: bigint; label: string } | null {
    const st = usePalace.getState();
    let inside = false;
    try {
      return this.palacePromptIn(feet, st, (v) => (inside = v));
    } finally {
      if (st.near !== inside) usePalace.setState({ near: inside });
    }
  }

  private palacePromptIn(feet: { x: number; y: number; z: number }, st: ReturnType<typeof usePalace.getState>, setInside: (v: boolean) => void): { kind: 150 | 152; id: bigint; label: string } | null {
    for (const s of this.palaces) {
      const [lx, lz] = palaceLocal(s, feet.x, feet.z);
      const dy = feet.y - s.floor;
      if (Math.abs(lx) > 40 || lz < -44 || lz > 70 || dy < -6 || dy > PALACE.ringY + 10) continue;
      setInside(true);
      const mine = st.site === s.index;
      for (let i = 0; i < 3; i++) {
        const w = PALACE.wards[i];
        if ((lx - w.x) ** 2 + (lz - w.z) ** 2 < 3.4 * 3.4 && Math.abs(dy - w.y) < 3) {
          if (mine && st.wards[i]) return null;
          return { kind: 152, id: BigInt((s.index << 4) | (i + 1)), label: `Strike the ${w.name}` };
        }
      }
      const c = PALACE.chest;
      if ((lx - c.x) ** 2 + (lz - c.z) ** 2 < 3.6 * 3.6 && Math.abs(dy - c.y) < 3) return { kind: 152, id: BigInt((s.index << 4) | 4), label: mine && st.phase === 3 ? (st.opened ? 'The chest (already taken)' : 'Open the treasure chest') : 'The chest (sealed with light)' };
      if (lz > 33 && lz < 64 && Math.abs(lx) < 22 && dy < 6) return { kind: 150, id: BigInt(s.index), label: mine && st.phase >= 1 ? 'The great doors (open)' : 'Knock at the great doors' };
    }
    return null;
  }

  /** Daylight and sky fill (WorldScene: from the time of day). */
  setLight(daySky: THREE.Color, dayIntensity: number, sunColor: THREE.Color, ambient: THREE.Color): void {
    verticalUniforms.uDayGlow.value.copy(daySky).multiplyScalar(dayIntensity);
    verticalUniforms.uSkyFill.value = Math.max(0.15, dayIntensity);
    if (this.decos.clouds) {
      this.decos.clouds.uniforms.uSun.value.copy(sunColor);
      this.decos.clouds.uniforms.uAmb.value.copy(ambient);
    }
  }

  private onResult(t: Tile, r: ResultMsg | null): void {
    if (!r || r.type !== 'layer') {
      if (!this.tiles.has(t.key)) return;
      t.state = 'empty';
      return;
    }
    if (!this.tiles.has(t.key)) return;
    if (r.raw) this.runtime.verticalStore?.putBytes(r.raw);
    this.stats.built++;
    this.stats.buildMs += r.genMs + r.meshMs;
    this.stats.maxMs = Math.max(this.stats.maxMs, r.genMs + r.meshMs);
    const m = r.mesh;
    if (m.index.length === 0 && m.wIndex.length === 0) {
      t.state = 'ready';
      return;
    }
    t.mesh = m.index.length ? this.surfaceMesh(m) : null;
    t.water = m.wIndex.length ? this.waterMesh(m) : null;
    if (t.mesh) this.layerGroups[t.layer].add(t.mesh);
    if (t.water) this.layerGroups[t.layer].add(t.water);
    t.state = 'ready';
  }

  private surfaceMesh(m: LayerMeshData): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.setAttribute('aGlow', new THREE.BufferAttribute(m.glow, 4));
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    const b = m.bounds;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mat = m.layer === LAYER_SKY ? this.island : m.layer === LAYER_DEPTHS ? this.deepRock : this.rock;
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = m.layer === LAYER_SKY && m.lod <= 2;
    mesh.receiveShadow = m.layer === LAYER_SKY;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  private waterMesh(m: LayerMeshData): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.wPositions, 3));
    g.setAttribute('aDepth', new THREE.BufferAttribute(m.wDepth, 1));
    g.setIndex(new THREE.BufferAttribute(m.wIndex, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, m.layer === LAYER_DEPTHS ? this.lava : this.water);
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  private dropTile(t: Tile): void {
    for (const o of [t.mesh, t.water]) {
      if (!o) continue;
      o.removeFromParent();
      o.geometry.dispose();
    }
    t.mesh = null;
    t.water = null;
  }

  dispose(): void {
    for (const t of this.tiles.values()) this.dropTile(t);
    this.tiles.clear();
    this.decos.dispose();
    for (const m of [this.rock, this.deepRock, this.island, this.water, this.lava]) m.dispose();
  }
}
