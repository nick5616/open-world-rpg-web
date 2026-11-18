// The one line the guide key can print ("Nothing to follow yet..."): a small
// pill low on the screen that fades after a few seconds. Everything else the
// wisp does is in the world (WispLayer).

import { useEffect, useState } from 'react';
import { useGuideNote } from './guideStore';
import { ToastBar } from '../../ui/toast/ToastBar';

const SHOW_MS = 3200;

export function GuideHud() {
  const note = useGuideNote((s) => s.note);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => tick((n) => n + 1), SHOW_MS + 50);
    return () => clearTimeout(id);
  }, [note]);
  if (!note || performance.now() - note.at > SHOW_MS) return null;
  return (
    <div
      key={note.at}
      data-testid="guide-note"
      style={{ position: 'fixed', left: '50%', top: '62%', transform: 'translateX(-50%)', overflow: 'hidden', padding: '6px 14px 9px', borderRadius: 14, background: 'rgba(8,10,16,0.55)', color: '#e9f6f1', font: '13px/1.35 system-ui, sans-serif', pointerEvents: 'none', zIndex: 12, animation: 'lsGuideNote 3.2s ease both' }}
    >
      {note.text}
      <ToastBar at={note.at} durationMs={SHOW_MS} color="rgba(159,230,200,0.9)" />
      <style>{'@keyframes lsGuideNote { 0% { opacity: 0 } 12% { opacity: 1 } 80% { opacity: 1 } 100% { opacity: 0 } }'}</style>
    </div>
  );
}
