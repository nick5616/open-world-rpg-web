import { describe, expect, it } from 'vitest';
import { hudStatusLine } from './VoiceHud';

describe('voice HUD status line (playtest 6 polish)', () => {
  it('says something a player understands instead of the raw LiveKit error', () => {
    const line = hudStatusLine('error', 'could not establish signal connection: Failed to fetch; retrying in 30 s');
    expect(line).not.toMatch(/signal|fetch|retrying in/);
    expect(line).toMatch(/voice/i);
  });
  it('is empty when connected or off', () => {
    expect(hudStatusLine('connected', 'x')).toBe('');
    expect(hudStatusLine('off', 'x')).toBe('');
    expect(hudStatusLine('error', '')).toBe('');
  });
});
