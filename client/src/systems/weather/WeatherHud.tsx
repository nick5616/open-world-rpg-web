// The weather on the HUD (CR 030): an icon and name on the clock pill, a
// short forecast line under it ("Storm coming soon"), and your cold
// status (Chilled, warm food). Online it sits inside NightHud's clock chip;
// solo, WeatherHud shows the same pill on its own.

import { useWeatherHud } from './runtime';
import { weatherIcon, weatherName } from './blend';
import { useNightHud } from '../night';

/** Icon + name, for the clock chip. */
export function WeatherChip() {
  const s = useWeatherHud();
  if (!s.active) return null;
  return (
    <span data-testid="weather-chip" title={weatherName(s.state)} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <span>{weatherIcon(s.state)}</span>
      <span style={{ opacity: 0.85 }}>{weatherName(s.state)}</span>
      {s.chilled && (
        <span data-testid="weather-chilled" style={{ color: '#9fd4ff' }}>
          · Chilled
        </span>
      )}
      {!s.chilled && s.warmS > 0 && <span style={{ color: '#ffc27a' }}>· Warm {Math.ceil(s.warmS / 60)}m</span>}
      {!s.chilled && !s.warmS && s.cold && <span style={{ color: '#bfe3ff' }}>· Freezing</span>}
    </span>
  );
}

/** The forecast line under the chip ("" when nothing changes soon). */
export function ForecastLine() {
  const line = useWeatherHud((s) => s.line);
  if (!line) return null;
  return (
    <div data-testid="weather-forecast" style={{ fontSize: 11, opacity: 0.8, marginTop: -3, textShadow: '0 1px 2px #000' }}>
      {line}
    </div>
  );
}

/** Solo: the pill without the night clock (online NightHud carries it). */
export function WeatherHud() {
  const online = useNightHud((s) => s.online);
  const active = useWeatherHud((s) => s.active);
  if (online || !active) return null;
  return (
    <div data-testid="weather-hud" style={{ position: 'fixed', top: 56, left: '50%', transform: 'translateX(-50%)', zIndex: 12, pointerEvents: 'none', font: '13px system-ui, sans-serif', color: '#e9ecef', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{ background: 'rgba(10,12,20,0.55)', padding: '3px 10px', borderRadius: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <WeatherChip />
      </div>
      <ForecastLine />
    </div>
  );
}
