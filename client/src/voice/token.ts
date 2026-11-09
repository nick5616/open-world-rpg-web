// voice_token over the social socket (contracts/social.yaml): the social
// service answers with the LiveKit URL and a join token for this world's
// room. Whether we may talk is the token's own grant (video.canPublish):
// false for players muted by a moderator (and for local profiles only when
// the server sets LODESTONE_VOICE_LOCAL_LISTEN_ONLY; playtest 2).

import { onSocialMessage, sendSocial } from '../social';
import type { VoiceToken } from './runtime';

/** The LiveKit grant's video.canPublish (true when the payload can't be read: the SFU enforces it anyway). */
export function tokenCanPublish(jwt: string): boolean {
  try {
    const seg = jwt.split('.')[1] ?? '';
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (seg.length % 4)) % 4);
    const claims = JSON.parse(atob(b64)) as { video?: { canPublish?: boolean } };
    return claims.video?.canPublish !== false;
  } catch {
    return true;
  }
}

export function requestVoiceToken(timeoutMs = 8000): Promise<VoiceToken> {
  return new Promise((resolve, reject) => {
    const done = () => {
      off();
      clearTimeout(timer);
    };
    const off = onSocialMessage((m) => {
      if (m.type === 'voice_token') {
        done();
        resolve({ url: m.url, token: m.token, canPublish: tokenCanPublish(m.token) });
      } else if (m.type === 'error' && /voice/i.test(m.message)) {
        done();
        reject(new Error(m.message));
      }
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error('no answer from the social service'));
    }, timeoutMs);
    // Queued by the socket until the session is authenticated.
    sendSocial({ type: 'voice_token' });
  });
}
