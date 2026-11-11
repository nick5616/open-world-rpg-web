// Playtest 2 voice settings: the live input meter. Reads an analyser every
// frame and writes the DOM directly (no React render per frame): RMS bar,
// peak tick (held ~1 s), RMS / peak dBFS numbers, a clip light (lit 1.5 s
// after a sample reaches full scale), and in open-mic mode the threshold
// line (drag on the meter to move it) and whether the gate would be open.

import { useEffect, useRef, type CSSProperties } from 'react';
import { dbToMeter, measure, VadGate } from '../vad';
import { useVoiceStore } from '../store';

const LO = -60;
const HI = 0;

export interface LevelMeterProps {
  /** The analyser to read (null: the meter rests and says why). */
  source: () => AnalyserNode | null;
  /** Show the open-mic threshold line and gate. */
  vad: boolean;
  idleText?: string;
  testId?: string;
  height?: number;
}

const fmt = (db: number) => (db <= -99 ? '-∞' : db.toFixed(1));

export function LevelMeter({ source, vad, idleText = 'No microphone yet', testId = 'voice-meter', height = 18 }: LevelMeterProps) {
  const bar = useRef<HTMLDivElement>(null);
  const peakTick = useRef<HTMLDivElement>(null);
  const nums = useRef<HTMLSpanElement>(null);
  const clip = useRef<HTMLSpanElement>(null);
  const gateEl = useRef<HTMLSpanElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const threshold = useVoiceStore((s) => s.vadThresholdDb);
  const srcRef = useRef(source);
  srcRef.current = source;

  useEffect(() => {
    let raf = 0;
    let buf = new Float32Array(1024);
    let peakHold = -100;
    let peakAt = 0;
    let clipAt = -1e9;
    const gate = new VadGate();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const a = srcRef.current();
      const now = performance.now();
      const s = useVoiceStore.getState();
      if (!a) {
        if (bar.current) bar.current.style.width = '0%';
        if (nums.current) nums.current.textContent = idleText;
        if (root.current) root.current.dataset.live = '0';
        return;
      }
      if (buf.length !== a.fftSize) buf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      const lv = measure(buf);
      if (lv.peakDb >= peakHold || now - peakAt > 1000) {
        peakHold = lv.peakDb;
        peakAt = now;
      }
      if (lv.clipped) clipAt = now;
      gate.configure({ thresholdDb: s.vadThresholdDb, attackMs: s.vadAttackMs, releaseMs: s.vadReleaseMs });
      const open = gate.update(lv.rmsDb, now);
      if (bar.current) {
        bar.current.style.width = `${dbToMeter(lv.rmsDb, LO, HI) * 100}%`;
        bar.current.style.background = lv.rmsDb > -6 ? '#ff6b6b' : lv.rmsDb > -18 ? '#ffd43b' : '#51cf66';
      }
      if (peakTick.current) peakTick.current.style.left = `calc(${dbToMeter(peakHold, LO, HI) * 100}% - 1px)`;
      if (nums.current) nums.current.textContent = `RMS ${fmt(lv.rmsDb)} dBFS · peak ${fmt(peakHold)} dBFS`;
      const clipping = now - clipAt < 1500;
      if (clip.current) {
        clip.current.style.background = clipping ? '#ff4d4f' : 'rgba(255,255,255,0.12)';
        clip.current.dataset.clipping = clipping ? '1' : '0';
      }
      if (gateEl.current) {
        gateEl.current.textContent = open ? 'open: sending' : 'closed';
        gateEl.current.style.color = open ? '#51cf66' : 'rgba(233,236,239,0.6)';
        gateEl.current.dataset.open = open ? '1' : '0';
      }
      if (root.current) {
        root.current.dataset.live = '1';
        root.current.dataset.rms = lv.rmsDb.toFixed(1);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [idleText]);

  // Drag on the meter to set the open-mic threshold.
  const setFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!vad) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const db = Math.round(Math.max(-60, Math.min(-10, LO + f * (HI - LO))));
    useVoiceStore.getState().setPrefs({ vadThresholdDb: db });
  };

  const track: CSSProperties = { position: 'relative', height, borderRadius: 4, background: 'rgba(255,255,255,0.1)', overflow: 'hidden', cursor: vad ? 'ew-resize' : 'default', touchAction: 'none' };
  return (
    <div ref={root} data-testid={testId} data-live="0">
      <div
        style={track}
        onPointerDown={(e) => {
          if (!vad) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setFromPointer(e);
        }}
        onPointerMove={(e) => e.buttons && setFromPointer(e)}
        title={vad ? 'Drag to set the open-mic threshold' : undefined}
      >
        {/* -18 / -6 dBFS guides */}
        {[-18, -6].map((g) => (
          <div key={g} style={{ position: 'absolute', top: 0, bottom: 0, left: `${dbToMeter(g, LO, HI) * 100}%`, width: 1, background: 'rgba(255,255,255,0.15)' }} />
        ))}
        <div ref={bar} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '0%', background: '#51cf66', transition: 'width 50ms linear' }} />
        <div ref={peakTick} style={{ position: 'absolute', top: 0, bottom: 0, width: 2, left: '-2px', background: '#f8f9fa' }} />
        {vad && <div data-testid="voice-threshold-line" style={{ position: 'absolute', top: -2, bottom: -2, left: `calc(${dbToMeter(threshold, LO, HI) * 100}% - 1px)`, width: 3, background: '#4dabf7', boxShadow: '0 0 4px #4dabf7' }} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
        <span ref={nums} style={{ opacity: 0.8 }} />
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span ref={clip} data-testid="voice-clip" style={{ width: 9, height: 9, borderRadius: 2, background: 'rgba(255,255,255,0.12)', display: 'inline-block' }} />
          clip
        </span>
        {vad && (
          <span>
            gate <span ref={gateEl} data-testid="voice-gate" />
          </span>
        )}
      </div>
      <div style={{ position: 'relative', height: 12, fontSize: 10, opacity: 0.45, marginTop: 1 }}>
        {[-60, -40, -18, -6, 0].map((g) => {
          const f = dbToMeter(g, LO, HI);
          return (
            <span key={g} style={{ position: 'absolute', left: `${f * 100}%`, transform: f === 0 ? 'none' : f === 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
              {g === 0 ? '0 dBFS' : g}
            </span>
          );
        })}
      </div>
    </div>
  );
}
