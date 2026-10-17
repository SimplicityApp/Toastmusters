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
  it('deletes the profile, the contact and only this user\'s artwork', async () => {
    const deleted = [];
    const env = {
      PROFILES: { delete: vi.fn(async (k) => { deleted.push(k); }) },
      CARD_ASSETS: makeBucket(['card/u1/aaa', 'card/u1/bbb', 'card/u2/ccc']),
    };

    const result = await purgeUserData(env, 'u1');

    expect(result).toEqual({ profileDeleted: true, assetsDeleted: 2, contactDeleted: true });
    expect(deleted).toEqual(['profile:zoom:u1', 'contact:zoom:u1']);
    expect([...env.CARD_ASSETS.objects]).toEqual(['card/u2/ccc']);
  });

  it('keeps going when one store fails, and does nothing without a uid', async () => {
    const env = {
      PROFILES: { delete: vi.fn(async () => { throw new Error('kv down'); }) },
      CARD_ASSETS: makeBucket(['card/u1/aaa']),
    };
    expect(await purgeUserData(env, 'u1')).toEqual({ profileDeleted: false, assetsDeleted: 1, contactDeleted: false });
    expect(await purgeUserData(env, '')).toEqual({ profileDeleted: false, assetsDeleted: 0, contactDeleted: false });
  });

  it('still deletes the profile and artwork when the contact delete fails', async () => {
    const deleted = [];
    const env = {
      PROFILES: {
        delete: vi.fn(async (k) => {
          if (k.startsWith('contact:')) throw new Error('kv down');
          deleted.push(k);
        }),
      },
      CARD_ASSETS: makeBucket(['card/u1/aaa']),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await purgeUserData(env, 'u1');

    expect(result).toEqual({ profileDeleted: true, assetsDeleted: 1, contactDeleted: false });
    expect(deleted).toEqual(['profile:zoom:u1']);
    expect(error).toHaveBeenCalledWith('Failed to delete contact for', 'u1', 'kv down');
    error.mockRestore();
  });

  it('deletes the contact even when the profile delete fails', async () => {
    const deleted = [];
    const env = {
      PROFILES: {
        delete: vi.fn(async (k) => {
          if (k.startsWith('profile:')) throw new Error('kv down');
          deleted.push(k);
        }),
      },
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await purgeUserData(env, 'u1')).toEqual({ profileDeleted: false, assetsDeleted: 0, contactDeleted: true });
    expect(deleted).toEqual(['contact:zoom:u1']);
    error.mockRestore();
  });

  it('skips the KV steps when PROFILES is not bound', async () => {
    const env = { CARD_ASSETS: makeBucket(['card/u1/aaa']) };
    expect(await purgeUserData(env, 'u1')).toEqual({ profileDeleted: false, assetsDeleted: 1, contactDeleted: false });
  });
});
