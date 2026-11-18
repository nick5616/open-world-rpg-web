// First: notes whether this browser played before, before anything writes settings (ui/whatsnew).
import './ui/whatsnew/news';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DEBUG } from './config';
import { installDevHandle } from './devHandle';
import { installAudioUnlock } from './audio/context';
import { installTitleMusic } from './audio/music/titleMusic';

if (DEBUG) installDevHandle();
// The first click or key (the Play button) creates and resumes the one AudioContext (autoplay rules).
installAudioUnlock();
// The title and character screens play Nicole's main menu theme from that first gesture (the engine is not loaded yet).
installTitleMusic();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
