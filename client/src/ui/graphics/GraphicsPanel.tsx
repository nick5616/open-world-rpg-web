// Graphics settings screen (playtest 2: "add graphics options for different
// kinds of rpg styles and graphics quality too"). Opened from the Graphics
// button in the top-right row (left of Sound) or F10; frees the mouse like
// the other panels (data-ui-panel hides the look hint). Everything it shows
// and sets lives in the quality store (stores/qualityStore.ts, persisted);
// the renderer reads the resolved numbers (stores/graphics.ts).

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { create } from 'zustand';
import {
  AA_MODES,
  CONTROL_RANGES,
  EFFECTS_SETTINGS,
  QUALITY_SETTINGS,
  SHADOW_MODES,
  useQualityStore,
  type AntiAlias,
  type EffectsSetting,
  type QualitySetting,
  type ShadowMode,
} from '../../stores/qualityStore';
import { useGraphics } from '../../stores/graphics';
import { STYLE_ORDER, STYLES } from '../../world/style/styles';
import { GRAPHICS_BUTTON_RIGHT, GRAPHICS_BUTTON_W, TOP_BUTTON_TOP } from '../../hud/layout';
import { useAudioSettings } from '../../audio/settings';
// Spell FX quality: the FX layer's own resolver (graphics High = FX Ultra, GPU cap on auto); the setting lives in the quality store.
import { currentFxTier } from '../../combat/fx/quality';

export const useGraphicsUi = create<{ open: boolean; setOpen: (v: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

/** Open/close; opening frees the mouse and closes the sound panel (they share the corner). */
export function setGraphicsOpen(open: boolean): void {
  useGraphicsUi.getState().setOpen(open);
  if (open) {
    useAudioSettings.getState().setPanelOpen(false);
    if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
  }
}

/** For other menus (the Esc menu, pt2/onboarding): open the Graphics screen. */
export function openGraphicsPanel(): void {
  setGraphicsOpen(true);
}

const glass: CSSProperties = {
  background: 'rgba(10,13,20,0.84)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  color: '#e9ecef',
  font: '13px system-ui, sans-serif',
};

const LABEL: Record<QualitySetting, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' };
const SHADOW_LABEL: Record<ShadowMode, string> = { off: 'Off', low: 'Low', high: 'High' };
const AA_LABEL: Record<AntiAlias, string> = { off: 'Off', fxaa: 'FXAA', msaa2: 'MSAA 2x', msaa4: 'MSAA 4x' };
const FX_LABEL: Record<EffectsSetting, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' };
const FPS_CHOICES = [0, 30, 60, 90, 120, 144];

export function GraphicsButton() {
  const open = useGraphicsUi((s) => s.open);
  return (
    <button
      data-testid="graphics-toggle"
      title="Graphics settings (F10)"
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setGraphicsOpen(!open)}
      style={{ ...glass, position: 'fixed', right: GRAPHICS_BUTTON_RIGHT, top: TOP_BUTTON_TOP, width: GRAPHICS_BUTTON_W, boxSizing: 'border-box', textAlign: 'center', zIndex: 31, padding: '5px 9px', cursor: 'pointer', opacity: 0.8 }}
    >
      Graphics
    </button>
  );
}

function Seg<T extends string | number>({ value, options, label, onChange, testid, disabled }: { value: T; options: readonly T[]; label: (v: T) => string; onChange: (v: T) => void; testid: string; disabled?: boolean }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 2, flexWrap: 'wrap', opacity: disabled ? 0.45 : 1 }}>
      {options.map((o) => (
        <button
          key={String(o)}
          data-silent
          data-value={String(o)}
          disabled={disabled}
          onClick={() => onChange(o)}
          style={{
            ...glass,
            borderRadius: 5,
            padding: '3px 8px',
            fontSize: 12,
            cursor: disabled ? 'default' : 'pointer',
            background: o === value ? 'rgba(120,170,255,0.32)' : 'rgba(255,255,255,0.05)',
            borderColor: o === value ? 'rgba(150,190,255,0.7)' : 'rgba(255,255,255,0.1)',
          }}
        >
          {label(o)}
        </button>
      ))}
    </div>
  );
}

function Row({ name, hint, children, dim }: { name: string; hint?: string; children: ReactNode; dim?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '112px 1fr', alignItems: 'center', gap: 8, margin: '6px 0', opacity: dim ? 0.55 : 1 }} title={hint}>
      <span>{name}</span>
      <div>{children}</div>
    </div>
  );
}

function Slider({ value, min, max, step, onChange, format, testid, disabled }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string; testid: string; disabled?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 74px', alignItems: 'center', gap: 6 }}>
      <input data-testid={testid} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <span style={{ textAlign: 'right', opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>{format(value)}</span>
    </div>
  );
}

const section: CSSProperties = { margin: '12px 0 4px', fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', opacity: 0.6 };

export function GraphicsPanel() {
  const open = useGraphicsUi((s) => s.open);
  const q = useQualityStore();
  const g = useGraphics();

  // F10 toggles; Escape closes (while open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text') || t.isContentEditable)) return;
      if (e.code === 'F10' && !e.repeat) {
        e.preventDefault();
        setGraphicsOpen(!useGraphicsUi.getState().open);
      } else if (e.code === 'Escape' && useGraphicsUi.getState().open) {
        setGraphicsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;
  const c = g.controls;
  const retro = g.retro !== null;
  const det = q.detected;
  const rings = Math.round(c.viewDistance / 64);
  return (
    <div data-testid="graphics-settings" data-ui-panel style={{ ...glass, position: 'fixed', right: 12, top: 46, zIndex: 32, padding: '10px 14px 12px', width: 360, maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 60px)', overflowY: 'auto', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 14 }}>Graphics</strong>
        <button data-silent data-testid="graphics-close" onClick={() => setGraphicsOpen(false)} style={{ ...glass, padding: '1px 8px', cursor: 'pointer' }} aria-label="Close">
          ×
        </button>
      </div>

      <div style={section}>Visual style</div>
      <div data-testid="graphics-style" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {STYLE_ORDER.map((id) => {
          const st = STYLES[id];
          const on = q.style === id;
          return (
            <button
              key={id}
              data-silent
              data-value={id}
              onClick={() => q.setStyle(id)}
              style={{ ...glass, textAlign: 'left', padding: '6px 8px', cursor: 'pointer', background: on ? 'rgba(120,170,255,0.26)' : 'rgba(255,255,255,0.04)', borderColor: on ? 'rgba(150,190,255,0.75)' : 'rgba(255,255,255,0.1)' }}
            >
              <div style={{ fontWeight: 600 }}>{st.label}</div>
              <div style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.3, marginTop: 2 }}>{st.blurb}</div>
            </button>
          );
        })}
      </div>

      <div style={section}>Quality</div>
      <Seg testid="graphics-preset" value={q.setting} options={QUALITY_SETTINGS} label={(v) => LABEL[v]} onChange={(v) => q.setSetting(v)} />
      <div data-testid="graphics-preset-note" style={{ fontSize: 11, opacity: 0.65, marginTop: 4 }}>
        {g.custom ? `Custom (on ${LABEL[q.setting]})` : q.setting === 'auto' ? `Auto: running ${LABEL[g.tier]}` : LABEL[q.setting]}
        {q.setting === 'auto' && det ? ` · detected ${LABEL[det.tier]}${det.frameMs !== null ? ` (${det.frameMs} ms frames)` : ''}` : ''}
        {retro ? ' · Retro caps view distance, AA and post effects' : ''}
      </div>

      <Row name="Render scale" hint="Fraction of the screen resolution rendered" dim={retro}>
        <Slider testid="graphics-render-scale" value={c.renderScale} min={CONTROL_RANGES.renderScale[0]} max={CONTROL_RANGES.renderScale[1]} step={0.05} disabled={retro} onChange={(v) => q.setControl('renderScale', v)} format={(v) => `${Math.round(v * 100)}%`} />
      </Row>
      <Row name="Pixel ratio cap" hint="Highest device pixel ratio used on hi-dpi screens" dim={retro}>
        <Slider testid="graphics-dpr" value={c.dprCap} min={CONTROL_RANGES.dprCap[0]} max={CONTROL_RANGES.dprCap[1]} step={0.25} disabled={retro} onChange={(v) => q.setControl('dprCap', v)} format={(v) => `${v.toFixed(2)}x`} />
      </Row>
      <Row name="Shadows">
        <Seg testid="graphics-shadows" value={c.shadows} options={SHADOW_MODES} label={(v) => SHADOW_LABEL[v]} onChange={(v) => q.setControl('shadows', v)} />
      </Row>
      <Row name="Shadow distance" dim={c.shadows === 'off'}>
        <Slider testid="graphics-shadow-distance" value={c.shadowDistance} min={CONTROL_RANGES.shadowDistance[0]} max={CONTROL_RANGES.shadowDistance[1]} step={20} disabled={c.shadows === 'off'} onChange={(v) => q.setControl('shadowDistance', v)} format={(v) => `${v} m`} />
      </Row>
      <Row name="View distance" hint="Terrain streams in 64 m chunks around you">
        <Slider testid="graphics-view-distance" value={c.viewDistance} min={CONTROL_RANGES.viewDistance[0]} max={CONTROL_RANGES.viewDistance[1]} step={100} onChange={(v) => q.setControl('viewDistance', v)} format={(v) => `${v} m · ${rings}`} />
      </Row>
      <Row name="Foliage" hint="Grass density and reach">
        <Slider testid="graphics-foliage" value={c.foliage} min={CONTROL_RANGES.foliage[0]} max={CONTROL_RANGES.foliage[1]} step={0.1} onChange={(v) => q.setControl('foliage', v)} format={(v) => (v <= 0.02 ? 'Off' : `${Math.round(v * 100)}%`)} />
      </Row>
      <Row name="Post effects" hint="Bloom, light shafts and FXAA (fog and colour grading always run)" dim={retro}>
        <Seg testid="graphics-post" value={c.post ? 'on' : 'off'} options={['off', 'on'] as const} label={(v) => (v === 'on' ? 'On' : 'Off')} disabled={retro} onChange={(v) => q.setControl('post', v === 'on')} />
      </Row>
      <Row name="Anti-aliasing" dim={retro}>
        <Seg testid="graphics-aa" value={c.antialias} options={AA_MODES} label={(v) => AA_LABEL[v]} disabled={retro} onChange={(v) => q.setControl('antialias', v)} />
      </Row>
      <Row name="Max FPS">
        <Seg testid="graphics-fps" value={c.maxFps} options={FPS_CHOICES} label={(v) => (v === 0 ? 'Unlimited' : String(v))} onChange={(v) => q.setControl('maxFps', v)} />
      </Row>
      <Row name="Spell effects" hint="Particles, lights, shake and flashes of spells">
        <Seg testid="graphics-effects" value={q.effects} options={EFFECTS_SETTINGS} label={(v) => (v === 'auto' && q.effects === 'auto' ? `Auto (${FX_LABEL[currentFxTier()]})` : FX_LABEL[v])} onChange={(v) => q.setEffects(v)} />
      </Row>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, fontSize: 11, opacity: 0.75 }}>
        <span>F10 or Esc to close · saved on this device</span>
        <button data-silent data-testid="graphics-reset" disabled={!g.custom} onClick={() => q.resetControls()} style={{ ...glass, padding: '2px 8px', cursor: g.custom ? 'pointer' : 'default', fontSize: 11, opacity: g.custom ? 1 : 0.5 }}>
          Reset to preset
        </button>
      </div>
    </div>
  );
}
