/**
 * Test-only: an in-memory namespace for the `ClubPlaces` Durable Object
 * (worker/club-places.js), for the #167 club tests. Not matched by vitest's
 * `**\/*.test.js` include, and never imported by worker/index.js, so none of
 * this reaches the deployed bundle.
 *
 * It runs the real class, one instance per `idFromName(clubId)`, against a
 * Map-backed `ctx.storage` whose every call waits a macrotask before it
 * settles. That delay is deliberate: a claim that checks the count, awaits
 * storage and only then adds would let two concurrent claims both see a free
 * place here, exactly as it could in a runtime without input gates. The plan
 * requires the check and the add to happen before any await, so they cannot
 * interleave in either.
 *
 * `ctx.id.name` is the club id the object was created for. Stubs forward RPC
 * calls (`stub.claim(uid)`) with structuredClone on the way in and out, like
 * the runtime's serialization boundary. `{ fail: true }` makes every stub call
 * reject, as an unreachable object would.
 */

let ClubPlacesClass;
try {
  ({ ClubPlaces: ClubPlacesClass } = await import('./club-places.js'));
} catch {
  ClubPlacesClass = undefined;
}

/** The class under test, or undefined while worker/club-places.js does not exist. */
export const ClubPlaces = ClubPlacesClass;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

export function makeSlowStorage() {
  const data = new Map();
  return {
    data,
    async get(keyOrKeys) {
      await tick();
      if (Array.isArray(keyOrKeys)) {
        const out = new Map();
        for (const key of keyOrKeys) if (data.has(key)) out.set(key, clone(data.get(key)));
        return out;
      }
      return clone(data.get(keyOrKeys));
    },
    async put(keyOrEntries, value) {
      await tick();
      if (typeof keyOrEntries === 'object' && keyOrEntries !== null) {
        for (const [key, v] of Object.entries(keyOrEntries)) data.set(key, clone(v));
        return;
      }
      data.set(String(keyOrEntries), clone(value));
    },
    async delete(keyOrKeys) {
      await tick();
      if (Array.isArray(keyOrKeys)) {
        let removed = 0;
        for (const key of keyOrKeys) if (data.delete(key)) removed += 1;
        return removed;
      }
      return data.delete(keyOrKeys);
    },
    async deleteAll() {
      await tick();
      data.clear();
    },
    async list({ prefix = '' } = {}) {
      await tick();
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Map(keys.map((k) => [k, clone(data.get(k))]));
    },
    async transaction(fn) {
      return fn(this);
    },
    async sync() {},
  };
}

/** A ctx the way the runtime hands one to a Durable Object's constructor. */
export function makePlacesCtx(name) {
  const pending = [];
  return {
    id: { name, toString: () => `name:${name}`, equals: (other) => String(other) === `name:${name}` },
    storage: makeSlowStorage(),
    blockConcurrencyWhile: async (fn) => fn(),
    waitUntil: (promise) => pending.push(promise),
    pending,
  };
}

/**
 * @param {() => Object} getEnv - the env the object is constructed with, read lazily
 *   so the namespace can sit inside the env it is given
 * @param {{fail?: boolean}} [options]
 */
export function makeClubPlacesNamespace(getEnv, { fail = false } = {}) {
  const objects = new Map();

  function entryFor(id) {
    const key = String(id);
    if (!objects.has(key)) {
      if (typeof ClubPlacesClass !== 'function') {
        throw new Error('worker/club-places.js does not export a ClubPlaces class');
      }
      const ctx = makePlacesCtx(id.name);
      objects.set(key, { ctx, instance: new ClubPlacesClass(ctx, getEnv()) });
    }
    return objects.get(key);
  }

  const makeId = (name) => ({ name, toString: () => `name:${name}`, equals: (o) => String(o) === `name:${name}` });

  function stubFor(id) {
    return new Proxy(
      { id },
      {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (prop === 'then') return undefined;
          return async (...args) => {
            if (fail) throw new Error('Durable Object unreachable (test)');
            const { instance } = entryFor(id);
            const member = instance[prop];
            if (typeof member !== 'function') throw new TypeError(`ClubPlaces has no method ${String(prop)}`);
            return clone(await member.apply(instance, args.map(clone)));
          };
        },
      }
    );
  }

  const namespace = {
    objects,
    idFromName: (name) => makeId(name),
    get: (id) => stubFor(id),
    getByName: (name) => stubFor(makeId(name)),
  };
  return namespace;
}
