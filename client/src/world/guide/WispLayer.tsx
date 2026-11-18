// The guiding wisp (CR 052): a small glowing mote that flies ahead of you
// toward the tracked quest's marker (or your map pin). Press . (G is the
// glider) or let a new quest step start it: it keeps 8-15 m ahead, waits when
// you stop, follows the roads you are on (route.ts over the towns buffer's
// road graph), otherwise floats over the terrain, chimes when it starts and
// fades as you arrive. One Points object of ~16 vertices (the head, a short
// trail, a few orbiting sparks): one draw call, emissive only, no lights.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { WorldRuntime } from '../core/runtime';
import { localPlayer } from '../../state/live';
import { useQuests, trackedQuest } from '../../ui/quests/store';
import { liveMarkers } from '../../ui/quests/live';
import { useExploration } from '../../ui/map/store';
import { hudActivity } from '../../hud/immersive';
import { emitSound } from '../../audio/bridge';
import { useMenu } from '../../ui/menu/store';
import { useQualityStore } from '../../stores/qualityStore';
import { AUTO_GUIDE_MS, guide, guideNote, installGuideKey, markedGoal } from './guideStore';
import { buildRoadGraph, newWisp, nearestNode, planRoute, pointAt, SNAP_M, stepWisp, type Route, type RoadGraph, type WispState } from './route';
import { pickGuideGoal, type GuideGoal } from './target';
import { diegeticDebug } from '../diegeticDebug';

const TRAIL = 11;
const SPARKS = 4;
const N = 1 + TRAIL + SPARKS;
/** Seconds between trail samples. */
const TRAIL_DT = 0.045;
/** Height over ground: on a road it skims, over terrain it floats. */
const HOVER_ROAD = 1.35;
const HOVER_FREE = 2.1;

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
varying float vA;
varying float vK;
uniform float uScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(110.0, aSize * uScale / max(0.5, -mv.z));
  vA = aAlpha;
  vK = aSize;
}`;
const FRAG = /* glsl */ `
varying float vA;
varying float vK;
uniform vec3 uCool;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = pow(max(0.0, 1.0 - d), 3.2);
  float halo = pow(max(0.0, 1.0 - d), 1.6) * 0.35;
  vec3 hot = vec3(1.0, 0.97, 0.86);
  vec3 cool = uCool;
  vec3 col = mix(cool, hot, core);
  gl_FragColor = vec4(col * (core * 2.2 + halo), (core + halo) * vA);
}`;

/** An additive glow-mote material: white-hot core, `cool` at the rim (module scope users keep it: never disposed, the pbrMaterial rule). */
export function makeGlowMaterial(cool: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { uScale: { value: 700 }, uCool: { value: new THREE.Color(cool) } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
}

let shared: THREE.ShaderMaterial | null = null;
/** The wisp's own material (a cool teal rim). */
export function wispMaterial(): THREE.ShaderMaterial {
  shared ??= makeGlowMaterial(new THREE.Color(0.42, 0.95, 0.86));
  return shared;
}

interface Run {
  active: boolean;
  auto: boolean;
  endAt: number;
  route: Route | null;
  w: WispState | null;
  goal: GuideGoal | null;
  planAt: number;
  chimedEnd: boolean;
  trailAcc: number;
  lastStepAt: number;
  autoDueAt: number;
}

export function WispLayer({ runtime }: { runtime: WorldRuntime }) {
  const scene = useThree((s) => s.scene);
  const graph = useMemo<RoadGraph | null>(() => {
    try {
      return runtime.towns ? buildRoadGraph(runtime.towns.roads) : null;
    } catch (err) {
      console.warn('[guide] no road graph', err);
      return null;
    }
  }, [runtime]);
  const obj = useMemo(() => {
    const pos = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const alpha = new Float32Array(N);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const pts = new THREE.Points(g, wispMaterial());
    pts.frustumCulled = false;
    pts.renderOrder = 6;
    pts.visible = false;
    pts.name = 'guide-wisp';
    const hist = new Float32Array(TRAIL * 3);
    return { pts, pos, size, alpha, g, hist };
  }, []);
  const run = useMemo<Run>(() => ({ active: false, auto: false, endAt: 0, route: null, w: null, goal: null, planAt: 0, chimedEnd: false, trailAcc: 0, lastStepAt: hudActivity.stepAt, autoDueAt: 0 }), []);

  useEffect(() => {
    diegeticDebug.graph = graph;
    diegeticDebug.wisp = run;
    scene.add(obj.pts);
    const off = installGuideKey(() => useMenu.getState().open);
    return () => {
      off();
      scene.remove(obj.pts);
      obj.g.dispose();
    };
  }, [scene, obj, graph, run]);

  const tmp = useMemo(() => ({ x: 0, z: 0 }), []);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1);
    const now = performance.now();
    const me = localPlayer.pos;
    const ground = runtime.terrainGround;
    const groundY = ground.heightAt(me.x, me.z);
    // Caves and the sky: nothing to follow there.
    const away = Math.abs(me.y - groundY) > 40;

    // A new quest step: a short guide by itself, a moment after the step's news.
    if (hudActivity.stepAt !== run.lastStepAt) {
      run.lastStepAt = hudActivity.stepAt;
      run.autoDueAt = now + 1600;
    }
    if (run.autoDueAt && now >= run.autoDueAt) {
      run.autoDueAt = 0;
      guide.auto = true;
    }

    const start = (auto: boolean): boolean => {
      const q = trackedQuest(useQuests.getState());
      // CR 055: "Guide me" on a place, or the place just marked in a conversation or the journal, comes before the quest.
      const place = guide.target ?? (auto ? null : markedGoal(now));
      guide.target = null;
      const goal: GuideGoal | null = place ? { x: place.x, z: place.z, kind: 'pin', label: place.label } : pickGuideGoal({ x: me.x, z: me.z }, liveMarkers(q), useExploration.getState().pins);
      if (!goal) {
        if (!auto) guideNote('Nothing to follow yet: track a quest (J) or set a pin on the map (M)');
        return false;
      }
      const d = Math.hypot(goal.x - me.x, goal.z - me.z);
      if (d < 30) {
        if (!auto) guideNote('You are already here');
        return false;
      }
      run.goal = goal;
      run.route = planRoute(graph, { x: me.x, z: me.z }, goal);
      run.w = newWisp(run.route, { x: me.x, z: me.z });
      run.active = true;
      run.auto = auto;
      run.endAt = auto ? now + AUTO_GUIDE_MS : Infinity;
      run.planAt = now;
      run.chimedEnd = false;
      obj.hist.fill(0);
      emitSound('wisp_chime');
      return true;
    };

    if (guide.go) {
      guide.go = false;
      if (!away) start(false);
      else guideNote('The wisp keeps to the surface');
    }
    if (guide.toggle) {
      guide.toggle = false;
      if (run.active && !run.auto) run.active = false; // pressed again: put it away
      else if (!away) start(false);
      else guideNote('The wisp keeps to the surface');
    }
    if (guide.auto) {
      guide.auto = false;
      const busy = useMenu.getState().open || !!document.querySelector('[data-ui-panel]:not([style*="display: none"])');
      if (!run.active && !away && !busy) start(true);
    }

    if (!run.active || !run.route || !run.w || away) {
      obj.pts.visible = false;
      if (away) run.active = false;
      return;
    }
    if (now > run.endAt && run.w.mode === 'fly') run.w.mode = 'fade';

    // Re-plan: you left the route, the goal moved, or you stepped onto a road while it was leading over the terrain.
    if (now - run.planAt > 1500) {
      const q = trackedQuest(useQuests.getState());
      const g2 = run.goal?.kind === 'quest' ? pickGuideGoal({ x: me.x, z: me.z }, liveMarkers(q), []) : run.goal;
      const moved = g2 && run.goal && Math.hypot(g2.x - run.goal.x, g2.z - run.goal.z) > 20;
      const onRoadNow = !run.route.usesRoad && !!graph && nearestNode(graph, me.x, me.z, SNAP_M) >= 0 && now - run.planAt > 6000;
      if (run.w.lost || moved || onRoadNow) {
        if (g2) run.goal = g2;
        if (run.goal) {
          const a = run.w.alpha;
          run.route = planRoute(graph, { x: me.x, z: me.z }, run.goal);
          run.w = newWisp(run.route, { x: me.x, z: me.z });
          run.w.alpha = a;
        }
        run.planAt = now;
      }
    }

    const w = run.w;
    stepWisp(w, run.route, { x: me.x, z: me.z }, dt);
    if (w.mode === 'gone') {
      run.active = false;
      obj.pts.visible = false;
      return;
    }
    if (w.mode === 'fade' && !run.chimedEnd) {
      run.chimedEnd = true;
      emitSound('wisp_chime', { volume: 0.55 });
    }

    // Place the head; clearance over ground (and water).
    const { p, leg } = pointAt(run.route, w.s, tmp);
    const onRoad = run.route.onRoad[leg];
    const t = state.clock.elapsedTime;
    const hover = (onRoad ? HOVER_ROAD : HOVER_FREE) + 0.22 * Math.sin(t * 2.3) + (w.waiting ? 0.18 * Math.sin(t * 4.1) : 0);
    const gy = Math.max(ground.heightAt(p.x, p.z), ground.waterAt(p.x, p.z));
    const hx = p.x + (w.waiting ? 0.35 * Math.cos(t * 1.7) : 0);
    const hz = p.z + (w.waiting ? 0.35 * Math.sin(t * 1.9) : 0);
    const hy = gy + hover;

    const tier = useQualityStore.getState().tier;
    const trailN = tier === 'low' ? 5 : TRAIL;
    const sparkN = tier === 'low' ? 0 : SPARKS;
    // Trail history: the head's positions every TRAIL_DT.
    run.trailAcc += dt;
    if (run.trailAcc >= TRAIL_DT) {
      run.trailAcc = 0;
      obj.hist.copyWithin(3, 0, (TRAIL - 1) * 3);
      obj.hist[0] = hx;
      obj.hist[1] = hy;
      obj.hist[2] = hz;
    }
    const { pos, size, alpha } = obj;
    const A = w.alpha;
    const breathe = 0.92 + 0.08 * Math.sin(t * 2.0);
    pos[0] = hx;
    pos[1] = hy;
    pos[2] = hz;
    size[0] = 1.05 * breathe;
    alpha[0] = A;
    for (let i = 0; i < TRAIL; i++) {
      const v = 1 + i;
      if (i >= trailN || (obj.hist[i * 3] === 0 && obj.hist[i * 3 + 2] === 0)) {
        alpha[v] = 0;
        size[v] = 0.01;
        continue;
      }
      const f = 1 - (i + 1) / (trailN + 1);
      pos[v * 3] = obj.hist[i * 3];
      pos[v * 3 + 1] = obj.hist[i * 3 + 1] - 0.04 * i;
      pos[v * 3 + 2] = obj.hist[i * 3 + 2];
      size[v] = 0.7 * f + 0.08;
      alpha[v] = A * f * 0.55;
    }
    for (let k = 0; k < SPARKS; k++) {
      const v = 1 + TRAIL + k;
      if (k >= sparkN) {
        alpha[v] = 0;
        size[v] = 0.01;
        continue;
      }
      const a = t * (1.6 + k * 0.45) + k * 1.9;
      const r = 0.38 + 0.12 * Math.sin(t * 1.3 + k);
      pos[v * 3] = hx + Math.cos(a) * r;
      pos[v * 3 + 1] = hy + Math.sin(a * 1.3) * 0.28;
      pos[v * 3 + 2] = hz + Math.sin(a) * r;
      size[v] = 0.18 + 0.07 * Math.sin(t * 2.2 + k * 2);
      alpha[v] = A * (0.6 + 0.3 * Math.sin(t * 1.4 + k));
    }
    obj.g.attributes.position.needsUpdate = true;
    obj.g.attributes.aSize.needsUpdate = true;
    obj.g.attributes.aAlpha.needsUpdate = true;
    const cam = state.camera as THREE.PerspectiveCamera;
    wispMaterial().uniforms.uScale.value = (state.size.height * 0.5) / Math.tan(((cam.fov ?? 70) * Math.PI) / 360);
    obj.pts.visible = A > 0.01;
    diegeticDebug.head.x = hx;
    diegeticDebug.head.y = hy;
    diegeticDebug.head.z = hz;
    diegeticDebug.head.visible = obj.pts.visible;
  });

  return null;
}
