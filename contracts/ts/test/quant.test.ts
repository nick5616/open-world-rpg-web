import { describe, expect, it } from 'vitest';
import { cmToMeters, metersToCm, pitchToU8, u8ToPitch, u16ToYaw, yawToU16, yawToU8, velToCms } from '../src';

describe('quantization', () => {
  it('round-trips positions to the centimeter', () => {
    expect(metersToCm(1234.567)).toBe(123457);
    expect(cmToMeters(metersToCm(-12.34))).toBeCloseTo(-12.34, 6);
  });
  it('wraps and quantizes angles', () => {
    expect(yawToU8(0)).toBe(0);
    expect(yawToU8(Math.PI)).toBe(128);
    expect(yawToU8(-Math.PI / 2)).toBe(192);
    expect(Math.abs(u16ToYaw(yawToU16(1.2345)) - 1.2345)).toBeLessThan(1e-4);
    expect(pitchToU8(10)).toBe(255);
    expect(u8ToPitch(pitchToU8(0))).toBeCloseTo(0, 1);
  });
  it('clamps velocity to int16 cm/s', () => {
    expect(velToCms(1000)).toBe(32767);
    expect(velToCms(-8.004)).toBe(-800);
    expect(velToCms(-0.005)).toBe(0); // JS Math.round: half rounds toward +inf; Go mirrors it;
  });
});
