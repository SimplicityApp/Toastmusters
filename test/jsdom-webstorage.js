/**
 * Put jsdom's `localStorage` back on the test global.
 *
 * Node 26 defines `globalThis.localStorage` itself — as a getter that answers
 * `undefined` unless the process was started with `--localstorage-file`. Vitest
 * copies a jsdom window key onto the global only when the key is not already
 * there or is on its own allow-list, and `localStorage` is on neither, so the
 * Node getter wins and jsdom's real storage never arrives: every
 * `localStorage.clear()` in a `beforeEach` throws, and with it every test of
 * every module this app persists anything from. Nothing in the app is wrong;
 * the harness simply lost the two objects its storage layer is built on.
 *
 * `globalThis.jsdom` is the DOM vitest built — the only handle on the real
 * window, since `globalThis.window` is the global itself.
 *
 * Loaded by each jsdom project's `setupFiles`, ahead of every other setup.
 */
const dom = globalThis.jsdom?.window ?? globalThis.document?.defaultView ?? null;

for (const key of ['localStorage', 'sessionStorage']) {
  if (dom?.[key] && globalThis[key] === undefined) {
    Object.defineProperty(globalThis, key, { value: dom[key], writable: true, configurable: true });
  }
}
