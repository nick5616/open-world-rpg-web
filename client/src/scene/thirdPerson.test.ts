import { describe, expect, it } from 'vitest';
import type { CollideResult, GroundQuery } from '../sim/ground';
import { aimFromEye, Boom, CameraProbe, crosshairDistance, forwardOf, rightOf, sweep, THIRD, type Blocked, type Vec3 } from './thirdPerson';

const DT = 1 / 60;
const eye: Vec3 = { x: 0, y: 1.8, z: 0 };
const open: Blocked = (_x, y) => y < 0.3; // flat ground at 0 with the clearance

describe('third-person boom', () => {
  it('in the open: full length, behind and over the right shoulder, looking where the view looks', () => {
    const b = new Boom();
    const c = b.update(eye, 0, 0, 1, 3.4, open, DT);
    expect(b.dist).toBeCloseTo(3.4, 5);
    expect(c.z).toBeGreaterThan(3); // yaw 0 looks down -Z: the camera is at +Z
    expect(c.x).toBeCloseTo(THIRD.shoulderX, 5); // right shoulder (+X at yaw 0)
    expect(c.y).toBeGreaterThan(eye.y);
    const left = new Boom().update(eye, 0, 0, -1, 3.4, open, DT);
    expect(left.x).toBeLessThan(-0.4);
    // The camera ray is parallel to the eye's view ray: same yaw/pitch, offset only.
    const b2 = new Boom();
    const yaw = 1.1;
    const c2 = b2.update(eye, yaw, 0, 1, 3, open, DT);
    const f = forwardOf(yaw, 0, { x: 0, y: 0, z: 0 });
    const r = rightOf(yaw, { x: 0, y: 0, z: 0 });
    const d = { x: c2.x - eye.x, z: c2.z - eye.z };
    expect(d.x * f.x + d.z * f.z).toBeCloseTo(-b2.dist, 3); // straight behind
    expect(d.x * r.x + d.z * r.z).toBeCloseTo(THIRD.shoulderX * b2.side, 3); // to the right
  });

  it('pulls in at once in front of a wall and never puts the camera inside it, then eases back out', () => {
    let wallZ = 1.5; // a wall across the boom, 1.5 m behind the eye
    const wall: Blocked = (x, y, z) => y < 0.3 || z > wallZ - 0.2;
    const b = new Boom();
    b.update(eye, 0, 0, 1, 3.4, open, DT);
    b.update(eye, 0, 0, 1, 3.4, open, DT);
    expect(b.dist).toBeGreaterThan(3.2);
    const c = b.update(eye, 0, 0, 1, 3.4, wall, DT); // the wall appears: same frame
    expect(wall(c.x, c.y, c.z)).toBe(false);
    expect(c.z).toBeLessThan(wallZ - 0.2);
    expect(c.z).toBeGreaterThan(wallZ - 0.2 - THIRD.margin - 0.05);
    // the wall goes away: the boom grows back over a few frames, not in one
    wallZ = 100;
    const d1 = b.update(eye, 0, 0, 1, 3.4, wall, DT);
    expect(d1.z).toBeLessThan(2.5);
    for (let i = 0; i < 90; i++) b.update(eye, 0, 0, 1, 3.4, wall, DT);
    expect(b.dist).toBeGreaterThan(3.3);
  });

  it('never goes under the terrain: looking up on a slope rising behind the player', () => {
    // ground rises toward +Z (behind) with slope 0.6
    const h = (z: number) => Math.max(0, z * 0.6);
    const slope: Blocked = (_x, y, z) => y < h(z) + THIRD.clearance;
    const b = new Boom();
    for (const pitch of [0, 0.4, 0.8, 1.2]) {
      const c = b.update(eye, 0, pitch, 1, 4, slope, DT);
      expect(c.y).toBeGreaterThanOrEqual(h(c.z) + THIRD.clearance - 1e-6);
    }
    expect(b.dist).toBeLessThan(2.5); // pulled in by the slope
  });

  it('a wall beside the head shrinks the shoulder offset instead of poking the camera through', () => {
    const side: Blocked = (x, y) => y < 0.3 || x > 0.3; // wall 0.3 m to the right
    const b = new Boom();
    const c = b.update(eye, 0, 0, 1, 3, side, DT);
    expect(side(c.x, c.y, c.z)).toBe(false);
    expect(b.side).toBeLessThan(0.6);
    expect(b.dist).toBeGreaterThan(2.8); // the boom itself still has room
  });

  it('every sample along the drawn boom is free (so the near plane never sits in geometry)', () => {
    // a pillar 2 m behind
    const pillar: Blocked = (x, y, z) => y < 0.3 || (Math.hypot(x - 0.4, z - 2) < 0.5 && y < 5);
    const b = new Boom();
    for (let i = 0; i < 30; i++) {
      const c = b.update(eye, 0, 0.1 * Math.sin(i), 1, 3.4, pillar, DT);
      for (let t = 0; t <= 1; t += 0.05) {
        expect(pillar(b.pivot.x + (c.x - b.pivot.x) * t, b.pivot.y + (c.y - b.pivot.y) * t, b.pivot.z + (c.z - b.pivot.z) * t)).toBe(false);
      }
    }
  });

  it('sweep bisects to the boundary', () => {
    const at = sweep(0, 0, 0, 0, 0, 10, (_x, _y, z) => z > 6.3, 0.5);
    expect(at * 10).toBeGreaterThan(6.2);
    expect(at * 10).toBeLessThanOrEqual(6.3);
  });
});

describe('CameraProbe on the movement ground', () => {
  it('blocks under the terrain, within 0.2 m of a wall (the body radius push), and under a ceiling', () => {
    const wallX = 5;
    const ground: GroundQuery = {
      heightAt: () => 0,
      collide: (x: number, y: number, z: number, out: CollideResult) => {
        // a wall face at x = 5 (solid for x > 5), body radius 0.4; a ceiling above y = 3
        out.x = x;
        out.y = y;
        out.z = z;
        out.pushX = x > wallX - 0.4 ? wallX - 0.4 - x : 0;
        out.pushZ = 0;
        out.ceiling = y + 1.9 > 3 && x < 0;
        return out;
      },
    };
    const p = new CameraProbe();
    p.setLevel(ground, 0);
    expect(p.blocked(0, 0.1, 10)).toBe(true); // under the clearance
    expect(p.blocked(2, 1.8, 0)).toBe(false);
    expect(p.blocked(4.6, 1.8, 0)).toBe(false); // the body's own distance from the wall: free
    expect(p.blocked(4.85, 1.8, 0)).toBe(true); // within 0.2 m
    expect(p.blocked(6, 1.8, 0)).toBe(true); // inside
    expect(p.blocked(-1, 2.8, 0)).toBe(true); // ceiling at 3 within 0.4 m
    expect(p.blocked(-1, 2.2, 0)).toBe(false);
  });
});

describe('crosshair convergence', () => {
  it('finds an enemy on the crosshair ray and aims the eye at it', () => {
    const cam = { x: 0.55, y: 2.05, z: 3.3 };
    const f = forwardOf(0, 0, { x: 0, y: 0, z: 0 });
    const enemy = { x: 0.55, y: 2.05, z: -10, r: 0.9 };
    const t = crosshairDistance(cam, f, 3.9, 90, () => 0, [enemy]);
    expect(t).toBeCloseTo(13.3 - 0.9, 3);
    const p = { x: cam.x + f.x * t, y: cam.y + f.y * t, z: cam.z + f.z * t };
    const e = { x: 0, y: 1.6, z: 0 };
    const aim = aimFromEye(e, p, 0, 0, { yaw: 0, pitch: 0 });
    // the eye's ray now passes through the point under the crosshair
    const d = forwardOf(aim.yaw, aim.pitch, { x: 0, y: 0, z: 0 });
    const k = (p.z - e.z) / d.z;
    expect(e.x + d.x * k).toBeCloseTo(p.x, 3);
    expect(e.y + d.y * k).toBeCloseTo(p.y, 3);
    expect(aim.yaw).toBeLessThan(0); // turned a little to the right
  });

  it('marches the terrain when no enemy is on the ray, and gives up at range', () => {
    const cam = { x: 0, y: 5, z: 0 };
    const f = forwardOf(0, -0.3, { x: 0, y: 0, z: 0 });
    const t = crosshairDistance(cam, f, 1, 90, () => 0, []);
    const y = cam.y + f.y * t;
    expect(Math.abs(y)).toBeLessThan(0.1); // hits the ground plane
    expect(crosshairDistance(cam, forwardOf(0, 0.2, { x: 0, y: 0, z: 0 }), 1, 90, () => 0, [])).toBe(90);
  });

  it('keeps the view aim when the point is beside the eye or the correction is too large', () => {
    const e = { x: 0, y: 1.6, z: 0 };
    expect(aimFromEye(e, { x: 0.3, y: 1.7, z: -0.5 }, 0.4, 0.1, { yaw: 0, pitch: 0 })).toEqual({ yaw: 0.4, pitch: 0.1 });
    expect(aimFromEye(e, { x: 3, y: 1.6, z: -3 }, 0, 0, { yaw: 0, pitch: 0 })).toEqual({ yaw: 0, pitch: 0 }); // 45 degrees off
  });

  it('keeps the converged yaw continuous across the +-PI seam', () => {
    const e = { x: 0, y: 1.6, z: 0 };
    const viewYaw = Math.PI - 0.01; // looking down +Z, nearly
    const p = { x: -0.3, y: 1.6, z: 20 };
    const aim = aimFromEye(e, p, viewYaw, 0, { yaw: 0, pitch: 0 });
    expect(Math.abs(aim.yaw - viewYaw)).toBeLessThan(0.1);
  });
});
