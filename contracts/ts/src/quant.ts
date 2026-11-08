// Quantization helpers (mirror of server/pkg/proto/quant.go). Not codecs: they
// convert units before encoding. Ported in spirit from 3d-portfolio-website
// src/multiplayer/protocol.ts (cm positions, byte angles).

const TAU = Math.PI * 2;
// "+ 0" turns -0 (Math.round(-0.4)) into 0 so equality and encoding stay boring.
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v)) + 0;
const wrap = (rad: number) => ((rad % TAU) + TAU) % TAU;

export const metersToCm = (m: number) => clamp(Math.round(m * 100), -2147483648, 2147483647);
export const cmToMeters = (c: number) => c / 100;
export const velToCms = (v: number) => clamp(Math.round(v * 100), -32768, 32767);
export const cmsToVel = (c: number) => c / 100;
export const yawToU8 = (rad: number) => Math.round((wrap(rad) / TAU) * 256) & 0xff;
export const u8ToYaw = (b: number) => (b / 256) * TAU;
export const yawToU16 = (rad: number) => Math.round((wrap(rad) / TAU) * 65536) & 0xffff;
export const u16ToYaw = (v: number) => (v / 65536) * TAU;
export const pitchToU8 = (rad: number) => Math.round((clamp(rad, -Math.PI / 2, Math.PI / 2) / Math.PI + 0.5) * 255);
export const u8ToPitch = (b: number) => (b / 255 - 0.5) * Math.PI;
export const pitchToI16 = (rad: number) => Math.round((clamp(rad, -Math.PI / 2, Math.PI / 2) / (Math.PI / 2)) * 32767);
export const i16ToPitch = (v: number) => (v / 32767) * (Math.PI / 2);
