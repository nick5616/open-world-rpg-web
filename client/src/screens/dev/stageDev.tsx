// Dev page for the character stage (client/stage-dev.html): the real
// CharacterScreen over the real CaveBackdrop with an in-memory fake account, so
// the select/create screens can be screenshotted without any service.
//   ?chars=N  seed N characters (default 2)   ?cave=0|1|lite  backdrop mode
import { StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CaveBackdrop } from '../stage/CaveBackdrop';
import { CharacterScreen, type CharacterRow } from '../../account/CharacterScreen';
import type { Look } from '../../net/look';

const SEED: CharacterRow[] = [
  { id: 'a', name: 'Nicole', level: 14, look: { build: 1, skin: 1, hairStyle: 3, hairColor: 5, beard: 0, eyes: 2 } },
  { id: 'b', name: 'Thorgrim', level: 7, look: { build: 2, skin: 4, hairStyle: 1, hairColor: 0, beard: 4, eyes: 3 } },
  { id: 'c', name: 'Wren', level: 3, look: { build: 0, skin: 0, hairStyle: 4, hairColor: 8, beard: 0, eyes: 1 } },
];

function Dev() {
  const n = Number(new URLSearchParams(location.search).get('chars') ?? 2);
  const [rows, setRows] = useState<CharacterRow[]>(SEED.slice(0, n));
  const [look, setLook] = useState<Look | null>(null);
  const onStage = useCallback((l: Look) => setLook(l), []);
  return (
    <CaveBackdrop variant="stage" look={look}>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} data-testid="account-screen" data-phase="characters">
        <CharacterScreen
          rows={rows}
          phase="characters"
          onPlay={() => undefined}
          onDelete={(id) => setRows((r) => r.filter((x) => x.id !== id))}
          onCreate={async (name, l) => {
            if (!name.trim()) return false;
            setRows((r) => [...r, { id: name, name, level: 1, look: l }]);
            return true;
          }}
          onStage={onStage}
        />
      </div>
    </CaveBackdrop>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Dev />
  </StrictMode>,
);
