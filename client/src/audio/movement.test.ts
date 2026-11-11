import { describe, expect, it } from 'vitest';
import { HOOF_M, LAND_MIN_SPEED, MovementSounds, STEP_SPRINT_M, STEP_WALK_M, type MoveSnapshot } from './movement';

const snap = (p: Partial<MoveSnapshot> = {}): MoveSnapshot => ({ mode: 'idle', grounded: true, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, airJumps: 0, underground: 0, inTown: false, ...p });

function walk(m: MovementSounds, mode: 'walk' | 'sprint', meters: number, extra: Partial<MoveSnapshot> = {}) {
  const fired: string[] = [];
  const dt = 1 / 60;
  const speed = mode === 'sprint' ? 8 : 4;
  let x = 0;
  m.update(snap({ mode, ...extra }), dt);
  while (x < meters) {
    x += speed * dt;
    for (const [n, p] of m.update(snap({ mode, pos: { x, y: 0, z: 0 }, ...extra }), dt)) fired.push(`${n}:${p.surface ?? ''}`);
  }
  return fired;
}

describe('movement sounds', () => {
  it('footsteps by distance: walking strides are shorter than sprinting ones', () => {
    const w = walk(new MovementSounds(), 'walk', 17);
    const s = walk(new MovementSounds(), 'sprint', 17);
    expect(w.length).toBe(Math.floor(17 / STEP_WALK_M));
    expect(s.length).toBe(Math.floor(17 / STEP_SPRINT_M));
    expect(w.every((x) => x === 'step:soft')).toBe(true);
  });

  it('in the saddle: hoofbeats by gait instead of footsteps (playtest 2 immersion pass)', () => {
    const gallop = walk(new MovementSounds(), 'sprint', 34, { mounted: true, gait: 2 });
    expect(gallop.length).toBe(Math.floor(34 / HOOF_M[2]));
    expect(gallop.every((x) => x === 'hoof:soft')).toBe(true);
    const trot = walk(new MovementSounds(), 'walk', 19, { mounted: true, gait: 0, inTown: true });
    expect(trot.length).toBe(Math.floor(19 / HOOF_M[0]));
    expect(trot[0]).toBe('hoof:hard');
    expect(walk(new MovementSounds(), 'walk', 10, { mounted: true, gait: 1 }).every((x) => x.startsWith('hoof'))).toBe(true);
  });

  it('stone underfoot in towns and caves', () => {
    expect(walk(new MovementSounds(), 'walk', 4, { inTown: true })[0]).toBe('step:hard');
    expect(walk(new MovementSounds(), 'walk', 4, { underground: 0.9 })[0]).toBe('step:hard');
  });

  it('the sampled surface wins: planks in town, wading, snow', () => {
    expect(walk(new MovementSounds(), 'walk', 4, { inTown: true, surface: 'wood' })[0]).toBe('step:wood');
    expect(walk(new MovementSounds(), 'walk', 4, { surface: 'water' })[0]).toBe('step:water');
    expect(walk(new MovementSounds(), 'walk', 4, { surface: 'snow' })[0]).toBe('step:snow');
  });

  it('jump, double jump and a landing that scales with the fall', () => {
    const m = new MovementSounds();
    m.update(snap(), 1 / 60);
    expect(m.update(snap({ grounded: false, mode: 'air', vel: { x: 0, y: 6, z: 0 }, pos: { x: 0, y: 0.1, z: 0 } }), 1 / 60).map((f) => f[0])).toEqual(['jump']);
    expect(m.update(snap({ grounded: false, mode: 'air', airJumps: 1, vel: { x: 0, y: 6, z: 0 }, pos: { x: 0, y: 1, z: 0 } }), 1 / 60).map((f) => f[0])).toEqual(['jump']);
    m.update(snap({ grounded: false, mode: 'air', airJumps: 1, vel: { x: 0, y: -9, z: 0 }, pos: { x: 0, y: 0.5, z: 0 } }), 1 / 60);
    const land = m.update(snap({ grounded: true, mode: 'idle', airJumps: 0 }), 1 / 60);
    expect(land[0][0]).toBe('land');
    expect(land[0][1].speed).toBeGreaterThanOrEqual(LAND_MIN_SPEED);
  });

  it('small drops land silently', () => {
    const m = new MovementSounds();
    m.update(snap(), 1 / 60);
    m.update(snap({ grounded: false, mode: 'air', vel: { x: 0, y: -1, z: 0 } }), 1 / 60);
    expect(m.update(snap(), 1 / 60)).toEqual([]);
  });

  it('water entry splashes, gliders open, climbing grabs', () => {
    const m = new MovementSounds();
    m.update(snap(), 1 / 60);
    expect(m.update(snap({ mode: 'swim', grounded: false }), 1 / 60).map((f) => f[0])).toContain('splash');
    const g = new MovementSounds();
    g.update(snap({ mode: 'air', grounded: false }), 1 / 60);
    expect(g.update(snap({ mode: 'glide', grounded: false }), 1 / 60).map((f) => f[0])).toEqual(['glide_open']);
    const c = new MovementSounds();
    c.update(snap(), 1 / 60);
    let grabs = 0;
    for (let i = 1; i <= 120; i++) for (const f of c.update(snap({ mode: 'climb', grounded: false, pos: { x: 0, y: i * 0.025, z: 0 } }), 1 / 60)) if (f[0] === 'climb') grabs++;
    expect(grabs).toBeGreaterThanOrEqual(5); // 3 m climbed: the first grab + one per 0.55 m
  });

  it('a teleport is not a footstep', () => {
    const m = new MovementSounds();
    m.update(snap({ mode: 'walk' }), 1 / 60);
    expect(m.update(snap({ mode: 'walk', pos: { x: 500, y: 0, z: 0 } }), 1 / 60)).toEqual([]);
  });
});
