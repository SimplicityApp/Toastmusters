import crypto from 'node:crypto';

/**
 * Test-only: an in-memory Durable Object namespace, for the poll tests
 * (worker/polls.test.js, worker/polls-zoom.test.js and the Playwright vote-page
 * test). Not matched by vitest's `**\/*.test.js` include, and never imported by
 * worker/index.js, so none of this reaches the deployed bundle.
 *
 * It runs the real Durable Object class against a Map-backed `state.storage`
 * with the transactional key-value API (get/put/delete/deleteAll/list) and one
 * alarm per object, which is the surface both KV-backed and SQLite-backed
 * objects offer. A stub answers both `stub.fetch(request)` and RPC calls
 * (`stub.someMethod(...)`), so the Worker may talk to its object either way.
 * `storage.sql` is deliberately absent.
 *
 * Alarms never fire on their own: a test moves the clock and calls
 * `runDueAlarms()`, the way the runtime would once the time came.
 */

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

// RPC may carry a Request, a Response or a stream, which the runtime passes
// through and structuredClone cannot copy: those cross by reference.
const rpcClone = (value) => {
  try {
    return clone(value);
  } catch {
    return value;
  }
};

function makeStorage() {
  const data = new Map();
  let alarm = null;

  const storage = {
    data,
    async get(keyOrKeys) {
      if (Array.isArray(keyOrKeys)) {
        const out = new Map();
        for (const key of keyOrKeys) if (data.has(key)) out.set(key, clone(data.get(key)));
        return out;
      }
      return clone(data.get(keyOrKeys));
    },
    async put(keyOrEntries, value) {
      if (typeof keyOrEntries === 'object' && keyOrEntries !== null) {
        for (const [key, v] of Object.entries(keyOrEntries)) data.set(key, clone(v));
        return;
      }
      data.set(keyOrKeys(keyOrEntries), clone(value));
    },
    async delete(keyOrKeys) {
      if (Array.isArray(keyOrKeys)) {
        let removed = 0;
        for (const key of keyOrKeys) if (data.delete(key)) removed += 1;
        return removed;
      }
      return data.delete(keyOrKeys);
    },
    async deleteAll() {
      data.clear();
    },
    async list({ prefix = '', start, end, limit, reverse = false } = {}) {
      let keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (start !== undefined) keys = keys.filter((k) => k >= start);
      if (end !== undefined) keys = keys.filter((k) => k < end);
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, clone(data.get(k))]));
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(when) {
      alarm = when instanceof Date ? when.getTime() : Number(when);
    },
    async deleteAlarm() {
      alarm = null;
    },
    async transaction(fn) {
      return fn(storage);
    },
    transactionSync(fn) {
      return fn(storage);
    },
    async sync() {},
    // Read by the namespace; not part of the runtime API.
    peekAlarm: () => alarm,
    clearAlarm: () => {
      alarm = null;
    },
  };
  return storage;
}

// put(key, value) with a non-string key is a caller bug in the runtime too.
function keyOrKeys(key) {
  return String(key);
}

function makeId(value, name) {
  const text = String(value);
  return {
    name,
    toString: () => text,
    equals: (other) => String(other) === text,
  };
}

/**
 * @param {Function|undefined} DurableObjectClass - e.g. PollRoom from worker/index.js
 * @param {() => Object} getEnv - the env the object is constructed with (read lazily,
 *   so the namespace can sit inside the env it is given)
 */
export function makeDurableObjectNamespace(DurableObjectClass, getEnv) {
  const objects = new Map();

  function objectFor(id) {
    const key = String(id);
    if (!objects.has(key)) {
      if (typeof DurableObjectClass !== 'function') {
        throw new Error('The Durable Object class is not exported from worker/index.js');
      }
      const storage = makeStorage();
      const pending = [];
      const state = {
        id,
        storage,
        blockConcurrencyWhile: async (fn) => fn(),
        waitUntil: (promise) => pending.push(promise),
      };
      const instance = new DurableObjectClass(state, getEnv());
      objects.set(key, { id, state, storage, instance, pending });
    }
    return objects.get(key);
  }

  function stubFor(entry) {
    const target = {
      id: entry.id,
      fetch: (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return entry.instance.fetch(request);
      },
    };
    return new Proxy(target, {
      get(obj, prop) {
        if (prop in obj) return obj[prop];
        if (prop === 'then') return undefined;
        const member = entry.instance[prop];
        if (typeof member !== 'function') return undefined;
        // RPC crosses a serialization boundary: nothing shared by reference.
        return async (...args) => rpcClone(await member.apply(entry.instance, args.map(rpcClone)));
      },
    });
  }

  const namespace = {
    objects,
    idFromName: (name) => makeId(`name:${name}`, name),
    idFromString: (value) => makeId(value),
    newUniqueId: () => makeId(crypto.randomBytes(32).toString('hex')),
    get: (id) => stubFor(objectFor(id)),
    getByName: (name) => namespace.get(namespace.idFromName(name)),

    /** Every object's storage, for tests that look for what must not be there. */
    allStorage: () => [...objects.values()].map((entry) => entry.storage.data),

    /** The earliest alarm any object has set, or null. */
    nextAlarm: () => {
      const times = [...objects.values()].map((e) => e.storage.peekAlarm()).filter((t) => t !== null);
      return times.length ? Math.min(...times) : null;
    },

    /** Every object's pending alarm, in ms. */
    alarms: () => [...objects.values()].map((e) => e.storage.peekAlarm()).filter((t) => t !== null),

    /**
     * Fire every alarm whose time has come (by Date.now()), once each, the way
     * the runtime would: the alarm is cleared before alarm() runs, so the
     * handler may set the next one.
     */
    async runDueAlarms(now = Date.now()) {
      let fired = 0;
      for (const entry of objects.values()) {
        const at = entry.storage.peekAlarm();
        if (at === null || at > now) continue;
        entry.storage.clearAlarm();
        if (typeof entry.instance.alarm === 'function') {
          // eslint-disable-next-line no-await-in-loop
          await entry.instance.alarm();
        }
        // eslint-disable-next-line no-await-in-loop
        await Promise.allSettled(entry.pending.splice(0));
        fired += 1;
      }
      return fired;
    },

    /** Settle anything an object handed to state.waitUntil. */
    async settle() {
      await Promise.allSettled([...objects.values()].flatMap((e) => e.pending.splice(0)));
    },
  };
  return namespace;
}

/** A Map-backed KV with per-key metadata and expiry options recorded (never enforced). */
export function makeKv(seed = {}) {
  const store = new Map(
    Object.entries(seed).map(([k, v]) => [k, { value: typeof v === 'string' ? v : JSON.stringify(v), metadata: null, options: null }])
  );
  const puts = [];
  // get(key, 'json') and get(key, { type: 'json' }) are the same call.
  const typeOf = (type) => (type && typeof type === 'object' ? type.type : type);
  const read = (entry, type) => (typeOf(type) === 'json' ? JSON.parse(entry.value) : entry.value);
  return {
    store,
    puts,
    get: async (key, type) => {
      const entry = store.get(key);
      return entry === undefined ? null : read(entry, type);
    },
    getWithMetadata: async (key, type) => {
      const entry = store.get(key);
      if (entry === undefined) return { value: null, metadata: null };
      return { value: read(entry, type), metadata: entry.metadata };
    },
    put: async (key, value, options) => {
      puts.push({ key, value, options: options ?? null });
      store.set(key, { value: typeof value === 'string' ? value : String(value), metadata: options?.metadata ?? null, options: options ?? null });
    },
    delete: async (key) => {
      store.delete(key);
    },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => ({ name, ...(entry.metadata ? { metadata: entry.metadata } : {}) })),
      list_complete: true,
    }),
  };
}

/** An ExecutionContext that keeps its waitUntil promises. */
export function makeCtx() {
  const promises = [];
  return {
    waitUntil: (p) => promises.push(p),
    passThroughOnException: () => {},
    settle: () => Promise.allSettled(promises.splice(0)),
  };
}

/** An ASSETS binding that has nothing, so a request that falls through is visible as one. */
export function makeEmptyAssets() {
  const calls = [];
  return {
    calls,
    fetch: async (request) => {
      calls.push(new URL(request.url).pathname);
      return new Response('not found', { status: 404, headers: { 'x-asset-path': new URL(request.url).pathname } });
    },
  };
}
