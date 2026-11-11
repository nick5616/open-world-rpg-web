// Runs a parsed /music command against the composer (loaded on demand, so
// the composer's code only downloads when the vibe explorer is used).

import { forceMusic, getComposer, muteBus, nowPlayingText, openAudioPicker, openMappingImport, overrideMusic, setComposerLog, soloBus, downloadMappings, useComposer } from '../../../audio/composer/composer';
import type { MusicCmd } from './commands';

type Log = (kind: 'ok' | 'err' | 'info', text: string) => void;

export function runMusic(cmd: MusicCmd, log: Log): void {
  setComposerLog(log);
  getComposer();
  const res = (r: string | null, ok: string) => (r && r.startsWith('error:') ? log('err', r.slice(6)) : r === null ? log('ok', ok) : log('ok', r));
  switch (cmd.op) {
    case 'now':
      for (const l of nowPlayingText(useComposer.getState().now)) log('info', l);
      return;
    case 'force':
      res(forceMusic(cmd.target, cmd.intensity), '');
      return;
    case 'intensity': {
      const e = overrideMusic({ kind: 'intensity', value: cmd.value });
      if (e) log('err', e);
      else log('ok', cmd.value === null ? 'intensity follows the world' : `intensity forced to ${cmd.value}`);
      return;
    }
    case 'solo':
      soloBus(cmd.bus);
      log('ok', cmd.bus ? `solo ${cmd.bus} (the other buses muted; voice chat untouched)` : 'solo off');
      return;
    case 'mute': {
      const now = muteBus(cmd.bus, cmd.on);
      log('ok', `${cmd.bus} ${now ? 'muted' : 'unmuted'}`);
      return;
    }
    case 'loop': {
      const e = overrideMusic({ kind: 'loop', a: cmd.a, b: cmd.b });
      if (e) log('err', e);
      else log('ok', `looping ${cmd.a.toFixed(1)}-${cmd.b.toFixed(1)} s`);
      return;
    }
    case 'loopOff':
      overrideMusic({ kind: 'loopOff' });
      log('ok', 'loop off (the whole track repeats)');
      return;
    case 'load':
      openAudioPicker();
      log('info', 'pick WAV/MP3/OGG/FLAC/M4A files: they play through the music bus, stay in this browser, and can be mapped to a vibe');
      return;
    case 'export': {
      const text = downloadMappings();
      log('ok', `exported ${useComposer.getState().mappings.length} mapping(s) (downloaded and copied; ${text.length} bytes)`);
      return;
    }
    case 'import':
      openMappingImport();
      return;
    case 'pin': {
      const pinned = cmd.on ?? !useComposer.getState().pinned;
      useComposer.setState({ pinned });
      log('ok', pinned ? 'now playing pinned over the game' : 'now playing unpinned');
      return;
    }
  }
}
