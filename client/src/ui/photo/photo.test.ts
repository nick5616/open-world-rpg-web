import { describe, expect, it } from 'vitest';
import { clampPhotoPos, focusDistance, PHOTO, PhotoCam, shotName, underground, type FlyInput, type PhotoGround } from './photoCamera';

const flat: PhotoGround = { heightAt: () => 10 };
const hill: PhotoGround = { heightAt: (x) => 10 + Math.max(0, x - 100) * 0.5 };
const lake: PhotoGround = { heightAt: () => 10, waterAt: (x) => (x > 50 ? 11 : -Infinity) };
const none: FlyInput = { forward: false, back: false, left: false, right: false, up: false, down: false, fast: false, slow: false };
const eye = { x: 100, y: 11.6, z: 100 };

describe('photo camera clamp', () => {
  it('stays within the radius of the eye', () => {
    const p = { x: 200, y: 11.6, z: 100 };
    expect(clampPhotoPos(p, eye, flat)).toBe(true);
    expect(Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z)).toBeCloseTo(PHOTO.radius, 5);
    const up = { x: 100, y: 500, z: 100 };
    clampPhotoPos(up, eye, flat);
    expect(up.y).toBeCloseTo(eye.y + PHOTO.radius, 5);
    const inside = { x: 110, y: 15, z: 95 };
    expect(clampPhotoPos(inside, eye, flat)).toBe(false);
    expect(inside).toEqual({ x: 110, y: 15, z: 95 });
  });
  it('never goes under the terrain or the water', () => {
    const p = { x: 105, y: 5, z: 100 };
    clampPhotoPos(p, eye, flat);
    expect(p.y).toBeCloseTo(10 + PHOTO.clearance);
    const onHill = { x: 120, y: 12, z: 100 };
    clampPhotoPos(onHill, eye, hill);
    expect(onHill.y).toBeGreaterThanOrEqual(hill.heightAt(onHill.x, onHill.z) + PHOTO.clearance - 1e-9);
    const wet = { x: 60, y: 10.5, z: 100 };
    clampPhotoPos(wet, { x: 60, y: 11.6, z: 100 }, lake);
    expect(wet.y).toBeGreaterThan(11);
  });
  it('in a cave only a smaller sphere holds (the terrain top is overhead)', () => {
    const caveEye = { x: 100, y: -20, z: 100 };
    expect(underground(caveEye, flat)).toBe(true);
    const p = { x: 100, y: -21, z: 130 };
    clampPhotoPos(p, caveEye, flat);
    expect(Math.hypot(p.x - 100, p.y + 20, p.z - 100)).toBeCloseTo(PHOTO.caveRadius, 5);
    expect(p.y).toBeLessThan(0); // not pushed up through the rock to the surface
  });
});

describe('photo camera flight', () => {
  it('flies along the view, strafes, rises; stays clamped every step', () => {
    const c = new PhotoCam();
    c.reset(eye, 0, 0, eye);
    c.step(1, { ...none, forward: true }, flat); // yaw 0 looks down -Z
    expect(c.pos.z).toBeCloseTo(eye.z - PHOTO.speed * 0.1, 5); // dt is capped at 0.1 s
    c.step(0.1, { ...none, right: true }, flat);
    expect(c.pos.x).toBeGreaterThan(eye.x);
    const y0 = c.pos.y;
    c.step(0.1, { ...none, up: true, fast: true }, flat);
    expect(c.pos.y).toBeCloseTo(y0 + PHOTO.fast * 0.1, 5);
    for (let i = 0; i < 200; i++) c.step(0.1, { ...none, forward: true, fast: true }, flat);
    expect(Math.hypot(c.pos.x - eye.x, c.pos.y - eye.y, c.pos.z - eye.z)).toBeLessThanOrEqual(PHOTO.radius + 1e-6);
    c.look(0, 10000);
    expect(c.pitch).toBeGreaterThanOrEqual(-1.55);
    for (let i = 0; i < 100; i++) c.step(0.1, { ...none, forward: true }, flat);
    expect(c.pos.y).toBeGreaterThanOrEqual(10 + PHOTO.clearance - 1e-9);
  });
  it('auto focus finds the ground ahead', () => {
    const d = focusDistance({ x: 0, y: 12, z: 0 }, 0, -Math.atan(2 / 10), flat);
    expect(d).toBeGreaterThan(9);
    expect(d).toBeLessThan(11);
    expect(focusDistance({ x: 0, y: 12, z: 0 }, 0, 0.3, flat)).toBe(150);
  });
  it('names shots by the local time', () => {
    expect(shotName(new Date(2026, 10, 10, 21, 4, 33))).toBe('lodestone-2026-11-10-21-04-33.png');
  });
});
