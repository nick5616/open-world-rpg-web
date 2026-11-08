// voice_token over the social socket (contracts/social.yaml): the social
// service answers with the LiveKit URL and a join token for this world's
// room (listen-only for local profiles).

import { onSocialMessage, sendSocial } from '../social';
import type { VoiceToken } from './runtime';

export function requestVoiceToken(timeoutMs = 8000): Promise<VoiceToken> {
  return new Promise((resolve, reject) => {
    const done = () => {
      off();
      clearTimeout(timer);
    };
    const off = onSocialMessage((m) => {
      if (m.type === 'voice_token') {
        done();
        resolve({ url: m.url, token: m.token });
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
