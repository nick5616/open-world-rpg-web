// In-world screen: the canvas plus DOM overlays. Lazy-loaded by App so the
// title screen doesn't pull in three.js. Online (WP06) when the account
// screen handed over a ReadySession, else the offline placeholder world
// (solo builds, "continue offline").
import { GameCanvas } from '../scene/GameCanvas';
import { DebugHud } from '../hud/DebugHud';
import { DebugPanel } from '../hud/DebugPanel';
import { Crosshair, LockHint } from '../hud/Overlays';
import { useDebugHotkeys } from '../hud/useDebugHotkeys';
import { useAppStore } from '../stores/appStore';
import { NetPlay, useOnlineSession } from '../net/NetPlay';
import { DEBUG, SOLO } from '../config';

function DebugLayer() {
  useDebugHotkeys();
  const hud = useAppStore((s) => s.hudVisible);
  const panel = useAppStore((s) => s.debugPanelOpen);
  return (
    <>
      {hud && <DebugHud />}
      {panel && <DebugPanel />}
    </>
  );
}

export default function PlayScreen() {
  const ready = useOnlineSession();
  const online = !SOLO && ready !== null;
  return (
    <>
      {online ? <NetPlay ready={ready} /> : <GameCanvas />}
      <Crosshair />
      <LockHint />
      {DEBUG && <DebugLayer />}
    </>
  );
}
