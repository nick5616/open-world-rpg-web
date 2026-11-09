import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DEBUG } from './config';
import { installDevHandle } from './devHandle';
import { installAudioUnlock } from './audio/context';

if (DEBUG) installDevHandle();
// The first click or key (the Play button) creates and resumes the one AudioContext (autoplay rules).
installAudioUnlock();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
