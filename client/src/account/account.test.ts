import { describe, expect, it } from 'vitest';
import { ApiError, LodestoneApi } from './api';
import { buildExport, parseExport } from './exportFile';
import type { SaveBlob } from './types';

const profile = { profileId: '0b5f0a6e-6a59-4f4e-9a52-6a7c1e1d2f3a', profileSecret: 'x'.repeat(43), createdAt: 1 };
const blob: SaveBlob = { format: 'lodestone-save', v: 1, profileId: profile.profileId, characterId: 'c1', worldId: 'w1', counter: 2, issuedAt: 5, state: '{"level":1}', sig: 'abc' };

describe('export file', () => {
  it('round-trips', () => {
    const exp = buildExport(profile, [blob], new Date(0));
    const back = parseExport(JSON.stringify(exp));
    expect(back.profile).toEqual(profile);
    expect(back.saves[0]).toEqual(blob);
  });
  it('rejects junk and damaged files', () => {
    expect(() => parseExport('not json')).toThrow(/not JSON/);
    expect(() => parseExport('{"format":"other"}')).toThrow(/not a Lodestone/);
    const exp = buildExport(profile, [blob]);
    expect(() => parseExport(JSON.stringify({ ...exp, v: 9 }))).toThrow(/version/);
    expect(() => parseExport(JSON.stringify({ ...exp, profile: { ...profile, profileSecret: 'short' } }))).toThrow(/secret/);
    // A save belonging to another profile cannot ride along in this file.
    expect(() => parseExport(JSON.stringify({ ...exp, saves: [{ ...blob, profileId: 'someone-else' }] }))).toThrow(/save entries/);
    expect(() => parseExport(JSON.stringify({ ...exp, saves: [{ ...blob, counter: 0 }] }))).toThrow(/save entries/);
  });
});

describe('api client', () => {
  it('sends bearer tokens and maps errors', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/connect')) {
        return new Response(JSON.stringify({ error: 'waking_world', message: 'Waking the world…', retryAfterS: 5 }), { status: 503 });
      }
      return new Response(JSON.stringify({ characters: [] }), { status: 200 });
    };
    const api = new LodestoneApi({ account: 'http://a', director: 'http://d' }, fake);
    await api.characters('tok', 'w1');
    expect(calls[0].url).toBe('http://a/v1/characters?worldId=w1');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const err = await api.connect('tok', 'c1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('waking_world');
    expect((err as ApiError).retryAfterS).toBe(5);
    expect((err as ApiError).status).toBe(503);
  });
  it('reports network failures', async () => {
    const api = new LodestoneApi({ account: 'http://a', director: 'http://d' }, async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api.worlds()).rejects.toMatchObject({ code: 'network', status: 0 });
  });
});
