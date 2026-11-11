// Playtest 2 voice settings: friendly help for the usual voice failures,
// read from the diagnostics snapshot. Most important first. Pure (tested).

import type { VoiceDiagnostics } from './diag';
import { voiceKeyLabel } from './keys';

export interface Tip {
  id: string;
  level: 'error' | 'warn' | 'info';
  title: string;
  text: string;
}

const UDP_HELP =
  'Voice audio travels over UDP (port 7882 on our server) and falls back to TCP (port 7881) when UDP is blocked. Work, school and hotel networks, some VPNs and strict firewalls block UDP: voice then goes over TCP or a TURN relay, which adds delay. If neither gets through, try another network, turn the VPN off, or allow those ports.';

export function voiceGuidance(d: VoiceDiagnostics): Tip[] {
  const tips: Tip[] = [];
  const mic = d.mic;
  const pub = d.publisher;

  if (d.status === 'off') {
    tips.push({ id: 'off', level: 'info', title: 'Voice is not running', text: 'Voice starts when you play online. Your microphone settings and the mic test still work here.' });
  }
  if (d.status === 'unavailable') {
    tips.push({ id: 'unavailable', level: 'warn', title: 'Voice is switched off on this server', text: d.statusText || 'The server has no voice service. Text chat (Enter) still works.' });
  }
  if (d.status === 'error' || (d.status === 'connecting' && d.room.connectFailures > 0)) {
    const pc = /pc connection|ice|peer connection|could not establish/i.test(d.statusText) || d.errors.some((e) => /pc connection|ice|could not establish/i.test(e.message));
    if (pc) tips.push({ id: 'udp', level: 'error', title: 'The voice server answered, but audio could not get through', text: UDP_HELP });
    else
      tips.push({
        id: 'unreachable',
        level: 'error',
        title: "Can't reach the voice server",
        text: `${d.room.url ? `Tried ${d.room.url.replace(/[?#].*$/, '')}. ` : ''}Voice retries by itself (every 1-30 s). Check your internet connection; if the game itself plays fine, a firewall or proxy may block WebSockets to the voice server. Reconnect voice tries again now.`,
      });
  }
  if (mic.permission === 'denied' || mic.lastProblem === 'denied' || mic.state === 'denied') {
    tips.push({
      id: 'denied',
      level: 'error',
      title: 'The browser blocked your microphone',
      text: 'Click the lock (or microphone) icon at the left of the address bar, set Microphone to Allow, then press Retry microphone. On Windows also check Settings > Privacy > Microphone ("Let desktop apps / browsers access your microphone"); on macOS System Settings > Privacy & Security > Microphone.',
    });
  } else if (mic.lastProblem === 'no-device' || (mic.inputCount === 0 && mic.permission === 'granted')) {
    tips.push({ id: 'no-device', level: 'error', title: 'No microphone found', text: 'Plug in a headset or microphone (or enable it in your system sound settings); the list updates by itself.' });
  } else if (mic.lastProblem === 'busy') {
    tips.push({ id: 'busy', level: 'error', title: 'The microphone is busy or failed to start', text: 'Another app may hold it exclusively (close it, or turn off "Allow applications to take exclusive control" in the Windows sound settings), or pick another microphone.' });
  } else if (mic.lastProblem === 'insecure') {
    tips.push({ id: 'insecure', level: 'error', title: 'The browser refuses the microphone on this page', text: 'Microphones only work on https:// pages (or localhost). Open the game from its https address.' });
  }
  if (mic.devicePick === 'fallback') {
    tips.push({ id: 'unplugged', level: 'warn', title: 'Your chosen microphone is not plugged in', text: `Using ${mic.deviceLabel || 'the system default'} until it comes back (voice switches back by itself).` });
  }
  if (d.listenOnly) {
    tips.push({
      id: 'listen-only',
      level: 'warn',
      title: 'Listen-only',
      text: d.listenOnlyReason ?? 'You can hear nearby players but not talk.',
    });
  }
  if (mic.muted && !d.listenOnly) {
    tips.push({ id: 'muted', level: 'info', title: 'Your microphone is muted', text: `Nobody hears you until you unmute (${voiceKeyLabel(mic.muteKey)} or the Mute button).` });
  }
  if (d.status === 'connected' && mic.state === 'idle' && !d.listenOnly && !mic.muted) {
    tips.push({
      id: 'not-asked',
      level: 'info',
      title: 'Microphone not started yet',
      text: mic.talkMode === 'ptt' ? `The browser asks for the microphone the first time you press ${voiceKeyLabel(mic.pttKey)}.` : 'Choose open mic again (or press Retry microphone) to start it.',
    });
  }
  if (mic.state === 'ready' && mic.levelDb !== null && mic.levelDb <= -90 && !mic.muted) {
    tips.push({ id: 'silent', level: 'warn', title: 'Your microphone sends silence', text: 'Check a hardware mute switch on the headset, the input volume in your system settings, or pick another microphone. The mic test shows the level live.' });
  }
  if (mic.talkMode === 'vad' && mic.levelDb !== null && mic.levelDb > -90 && mic.levelDb < -75) {
    tips.push({ id: 'quiet', level: 'info', title: 'Your microphone is very quiet', text: 'Raise the input boost, move the microphone closer, or lower the open-mic threshold.' });
  }
  if (d.audio.contextState === 'suspended') {
    tips.push({ id: 'suspended', level: 'warn', title: 'Sound is paused by the browser', text: 'Browsers start audio only after you interact with the page: click anywhere in the game or press a key.' });
  }
  const t = pub?.transport ?? d.speakers.find((s) => s.stats?.transport)?.stats?.transport ?? null;
  if (t && (t.localType === 'relay' || t.remoteType === 'relay')) {
    tips.push({ id: 'relay', level: 'info', title: 'Voice goes through a TURN relay', text: 'A direct connection was not possible (UDP blocked or a strict NAT), so audio is relayed. It works, with a little more delay. ' + UDP_HELP });
  } else if (t && t.protocol === 'tcp') {
    tips.push({ id: 'tcp', level: 'info', title: 'Voice is using TCP', text: 'UDP seems blocked on your network, so audio falls back to TCP: it works, but lost packets arrive late instead of being skipped. ' + UDP_HELP });
  }
  if (pub && pub.lossPct !== null && pub.lossPct > 5) {
    tips.push({ id: 'loss', level: 'warn', title: `Losing ${Math.round(pub.lossPct)} % of your voice packets`, text: 'Your connection drops audio on the way to the server (Wi-Fi far from the router, a busy network, a download running). Others hear you choppy.' });
  }
  const rtt = pub?.rttMs ?? t?.rttMs ?? null;
  if (rtt !== null && rtt > 300) {
    tips.push({ id: 'rtt', level: 'warn', title: `High delay to the voice server (${Math.round(rtt)} ms)`, text: 'Conversation will feel laggy. A wired connection or a closer network helps.' });
  }
  if (d.room.reconnects >= 3) {
    tips.push({ id: 'flaky', level: 'warn', title: `Voice reconnected ${d.room.reconnects} times`, text: 'Your connection to the voice server keeps dropping. If it persists, check Wi-Fi strength or another network.' });
  }
  return tips;
}
