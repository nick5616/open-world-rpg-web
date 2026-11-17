// CR 044: the Glide Ring Race on the client. The zone owns the course, the
// clock and the rewards (Event 1706); this is its mirror: the rings to draw,
// the ring you are heading for, a clock that runs between the zone's updates,
// and the result.
import * as THREE from 'three';
import { create } from 'zustand';

export interface RaceCourse {
  stand: number;
  rings: [number, number, number, number, number][];
  r: number;
  gold: number;
  silver: number;
  bronze: number;
  armS: number;
  limitS: number;
  best: number;
  board: { n: string; ms: number }[];
}

export interface RaceResult {
  ms: number;
  medal: string;
  gold: number;
  xp: number;
  rank: number;
  pb: boolean;
  best: number;
  paid: boolean;
  relic: boolean;
  board: { n: string; ms: number }[];
}

export interface RaceState {
  phase: 'idle' | 'armed' | 'running' | 'done' | 'failed';
  course: RaceCourse | null;
  /** The ring you are heading for. */
  next: number;
  /** performance.now() when the first ring was flown. */
  startedAt: number;
  result: RaceResult | null;
  message: string;
  /** When the state was last set (the HUD hides finished panels after a while). */
  at: number;
}

export const useRace = create<RaceState>(() => ({ phase: 'idle', course: null, next: 0, startedAt: 0, result: null, message: '', at: 0 }));

export const RACE = { armed: 1, ring: 2, finished: 3, failed: 4, disarmed: 5 } as const;

export function onRaceEvent(value: number, data: Uint8Array | undefined, notice: (text: string, kind: 'dawn' | 'night' | 'danger', ms: number) => void): void {
  const now = performance.now();
  const text = () => new TextDecoder().decode(data ?? new Uint8Array(0));
  switch (value) {
    case RACE.armed:
      try {
        const w = JSON.parse(text()) as RaceCourse;
        useRace.setState({ phase: 'armed', course: w, next: 0, startedAt: 0, result: null, message: '', at: now });
        notice('Glide Ring Race: jump from the rim and fly through the first gold ring. The clock starts there.', 'dawn', 6000);
      } catch {
        /* ignore */
      }
      break;
    case RACE.ring: {
      const k = data?.[0] ?? 0;
      const ms = data ? (data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24)) >>> 0 : 0;
      const s = useRace.getState();
      useRace.setState({ phase: 'running', next: k + 1, startedAt: k === 0 ? now : now - ms, at: now });
      void s;
      break;
    }
    case RACE.finished:
      try {
        const r = JSON.parse(text()) as RaceResult;
        useRace.setState({ phase: 'done', result: r, at: now });
        notice(r.medal ? `${r.medal[0].toUpperCase()}${r.medal.slice(1)} medal: ${(r.ms / 1000).toFixed(2)} s${r.paid ? `, +${r.gold} gold, +${r.xp} XP` : ''}${r.relic ? ' and a relic' : ''}` : `Finished in ${(r.ms / 1000).toFixed(2)} s (no medal: fly it faster)`, r.medal ? 'dawn' : 'night', 7000);
      } catch {
        /* ignore */
      }
      break;
    case RACE.failed:
      useRace.setState({ phase: 'failed', message: text(), at: now });
      notice(`Race over: ${text()}`, 'night', 4500);
      break;
    default:
      useRace.setState({ phase: 'idle', course: null, at: now });
  }
}

/** The course's rings in the scene: the one you are heading for pulses, the ones behind fade. */
export class RaceRings {
  readonly group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private built: RaceCourse | null = null;
  private readonly geo = new THREE.TorusGeometry(1, 0.1, 8, 40);
  private readonly mats = {
    next: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 0.95, 0.1), fog: false }),
    ahead: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.42, 0.05), transparent: true, opacity: 0.95 }),
    done: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.75, 0.4), transparent: true, opacity: 0.35 }),
  };

  update(time: number): void {
    const s = useRace.getState();
    const c = s.phase === 'armed' || s.phase === 'running' ? s.course : null;
    if (c !== this.built) {
      for (const m of this.meshes) this.group.remove(m);
      this.meshes = [];
      this.built = c;
      if (c) {
        for (const [x, y, z, nx, nz] of c.rings) {
          const m = new THREE.Mesh(this.geo, this.mats.ahead);
          m.position.set(x, y, z);
          m.rotation.y = Math.atan2(nx, nz);
          m.scale.setScalar(c.r);
          this.group.add(m);
          this.meshes.push(m);
        }
      }
    }
    if (!c) return;
    this.meshes.forEach((m, i) => {
      m.material = i < s.next ? this.mats.done : i === s.next ? this.mats.next : this.mats.ahead;
      // A slow swell (about 0.4 Hz, small) on the ring to fly through next.
      m.scale.setScalar(c.r * (i === s.next ? 1 + Math.sin(time * 2.4) * 0.04 : 1));
    });
  }

  dispose(): void {
    this.geo.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
  }
}
