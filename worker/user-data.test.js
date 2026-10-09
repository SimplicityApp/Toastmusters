import { describe, it, expect, vi } from 'vitest';
import { purgeUserData } from './user-data.js';

function makeBucket(keys) {
  const objects = new Set(keys);
  return {
    objects,
    list: vi.fn(async ({ prefix }) => ({
      objects: [...objects].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1 })),
      truncated: false,
    })),
    delete: vi.fn(async (ks) => { for (const k of Array.isArray(ks) ? ks : [ks]) objects.delete(k); }),
  };
}

describe('purgeUserData', () => {
  it('deletes the profile and only this user\'s artwork', async () => {
    const deleted = [];
    const env = {
      PROFILES: { delete: vi.fn(async (k) => { deleted.push(k); }) },
      CARD_ASSETS: makeBucket(['card/u1/aaa', 'card/u1/bbb', 'card/u2/ccc']),
    };

    const result = await purgeUserData(env, 'u1');

    expect(result).toEqual({ profileDeleted: true, assetsDeleted: 2 });
    expect(deleted).toEqual(['profile:zoom:u1']);
    expect([...env.CARD_ASSETS.objects]).toEqual(['card/u2/ccc']);
  });

  it('keeps going when one store fails, and does nothing without a uid', async () => {
    const env = {
      PROFILES: { delete: vi.fn(async () => { throw new Error('kv down'); }) },
      CARD_ASSETS: makeBucket(['card/u1/aaa']),
    };
    expect(await purgeUserData(env, 'u1')).toEqual({ profileDeleted: false, assetsDeleted: 1 });
    expect(await purgeUserData(env, '')).toEqual({ profileDeleted: false, assetsDeleted: 0 });
  });
});
