import '@testing-library/jest-dom';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { BREAK_ROLE, DEFAULT_ROLE_RULES, resetFlagsForTests, setFlags } from '@toastmaster-timer/shared';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider, useTimer, useTimerTick } from '../context/TimerContext';
import { applyOverlay, removeOverlay, getOverlayMode } from '../utils/zoomSdk';
import TimerTab from './TimerTab';

/**
 * #168, on-the-spot speakers, in the Zoom app's new look (design B, behind
 * `new_look`). The timer card's speaker chip carries the status; its popover
 * holds the name field, the actions, the add panel and the lists, with
 * "Speaker options" at its foot. The card's role chip edits the role, staged for
 * a loaded row like the old look's role picker. Same words as the old look and
 * the web (see LiveTab.speakerEntry.test.jsx), read through the timer context
 * every view shares.
 */

vi.mock('../utils/zoomSdk', () => ({
  getVideoState: vi.fn().mockResolvedValue(null),
  setVideoState: vi.fn(),
  applyOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  clearVideoPipelines: vi.fn().mockResolvedValue({ ok: true, declined: false, ungranted: [], lostBackground: false }),
  isOverlayActive: vi.fn(() => false),
  getBackgroundUrl: vi.fn((color) => `/backgrounds/${color}.png`),
  getSdkStatus: vi.fn(() => ({ initialized: true, available: false, sdkExists: false, missingApis: [], apiCount: 0 })),
  setLogCallback: vi.fn(),
  getOverlayMode: vi.fn(() => 'camera'),
  setOverlayMode: vi.fn().mockResolvedValue(undefined),
  getOverlayTimePosition: vi.fn(() => ({ x: 0.18, y: 0.3 })),
  setOverlayTimePosition: vi.fn(),
  getOverlayTimeScale: vi.fn(() => 0.18),
  setOverlayTimeScale: vi.fn((scale) => scale),
  isOverlayTimeVisible: vi.fn(() => true),
  setOverlayTimeVisible: vi.fn(),
  setOverlayTimeLabel: vi.fn(),
  setPopoutChangeCallback: vi.fn(),
  setShareChangeCallback: vi.fn(),
  setAppShare: vi.fn(),
  setAppPopout: vi.fn(),
  isAppShareActive: vi.fn(() => false),
  isAppPoppedOut: vi.fn(() => false),
  isVideoOverlayMode: vi.fn((mode) => mode !== 'stage'),
  getClubBadgePlacement: vi.fn(() => ({ x: 0.8, y: 0.12, scale: 0.12, visible: true })),
  setClubBadgePlacement: vi.fn((patch) => ({ x: 0.8, y: 0.12, scale: 0.12, visible: true, ...patch })),
  resetClubBadgePlacement: vi.fn(() => ({ x: 0.8, y: 0.12, scale: 0.12, visible: true })),
  isClubBadgeMoved: vi.fn(() => false),
  getZoomParticipants: vi.fn().mockResolvedValue({ participants: [], role: 'host', restricted: false }),
  getCardFileUrl: vi.fn((file) => `/cards/${file}`),
  notifyCardImagesChanged: vi.fn(),
  preloadBackgroundImages: vi.fn(),
  notifyOwnBackgroundChanged: vi.fn(),
  applyOwnBackground: vi.fn(),
  removeOwnBackground: vi.fn(),
  openExternalUrl: vi.fn(async () => true),
  OVERLAY_MODE_CARD: 'card',
  OVERLAY_MODE_CAMERA: 'camera',
  OVERLAY_MODE_STAGE: 'stage',
}));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../utils/zoomIdentity', () => ({
  resolveZoomIdentity: vi.fn(async () => ({ identified: false })),
  getSessionToken: vi.fn(() => null),
}));

const RULES = {
  'Standard Speech': DEFAULT_ROLE_RULES['Standard Speech'],
  'Ice Breaker': DEFAULT_ROLE_RULES['Ice Breaker'],
  'Table Topics Speech': DEFAULT_ROLE_RULES['Table Topics Speech'],
};
const SEED = [
  { id: 'a', name: 'Ana', role: 'Standard Speech', rules: RULES['Standard Speech'], completed: false },
  { id: 'b', name: 'Jordan', role: 'Ice Breaker', rules: RULES['Ice Breaker'], completed: false },
  { id: 'c', name: 'Cole', role: 'Standard Speech', rules: RULES['Standard Speech'], completed: false },
];
const TT = 'Table Topics Speech';
const INSERT_KEY = 'toastmaster_speaker_insert_position';
const ENTER_KEY = 'toastmaster_speaker_enter_action';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ctx = {};
function Probe() {
  Object.assign(ctx, useTimer(), useTimerTick());
  return null;
}

function renderTimerTab() {
  return render(
    <ToastProvider>
      <TimerProvider>
        <Probe />
        <TimerTab onGoToAgenda={() => {}} onOpenRules={() => {}} />
      </TimerProvider>
    </ToastProvider>
  );
}

const names = () => ctx.agenda.map((item) => item.name);
const row = (name) => ctx.agenda.find((item) => item.name === name);
const loadJordan = () => act(() => ctx.loadSpeakerFromAgenda('b'));
const tick = (ms) => act(() => {
  vi.advanceTimersByTime(ms);
});
const body = () => document.body;

const squash = (text) => (text || '').replace(/\s+/g, '');
function shows(scope, text) {
  const want = squash(text);
  if (squash(scope.textContent).includes(want)) return true;
  return [...scope.querySelectorAll('[aria-label],[title]')].some(
    (el) => squash(el.getAttribute('aria-label')).includes(want) || squash(el.getAttribute('title')).includes(want)
  );
}
function control(scope, pattern) {
  for (const role of ['button', 'option', 'menuitem', 'link']) {
    const found = within(scope).queryAllByRole(role, { name: pattern });
    if (found.length) return found[0];
  }
  return null;
}
function expectControl(scope, pattern) {
  const el = control(scope, pattern);
  expect(el, `a control named ${pattern}`).not.toBeNull();
  return el;
}
function expectNoUpdate(scope) {
  const update = control(scope, /Update .* on the agenda/);
  expect(update === null || update.disabled, 'no Update button with nothing staged').toBe(true);
}
const hasIcon = (el) => Boolean(el.querySelector('svg')) || /^[^\w\s]/.test(el.textContent.trim());
function expectStatusNotAButton(scope) {
  expect(within(scope).queryAllByRole('button', { name: /^\W*(On the agenda|Not on the agenda)/ })).toHaveLength(0);
}
function pressEnter(el) {
  const init = { key: 'Enter', code: 'Enter', keyCode: 13, charCode: 13 };
  const proceed = fireEvent.keyDown(el, init);
  if (proceed) fireEvent.keyPress(el, init);
  fireEvent.keyUp(el, init);
  if (proceed && el.form) fireEvent.submit(el.form);
}
const textboxes = (scope) => within(scope).queryAllByRole('textbox');
const fresh = (after, before) => after.filter((el) => !before.includes(el));

/** The speaker chip on the timer card. */
function chip() {
  const card = screen.getByTestId('timer-card');
  const [found] = within(card).queryAllByRole('button', { name: /speak|who/i });
  expect(found, 'the timer card has a speaker chip').toBeTruthy();
  return found;
}
/** Opens the speaker popover (if it is not open) and returns its name field. */
function openPopover() {
  const c = chip();
  if (c.getAttribute('aria-expanded') !== 'true') fireEvent.click(c);
  const [field] = textboxes(body());
  expect(field, 'the speaker popover has a name field').toBeTruthy();
  return field;
}
/** An action in the popover. */
function popoverAction(pattern) {
  if (!control(body(), pattern)) openPopover();
  return expectControl(body(), pattern);
}
/**
 * The card's role chip, for the role on the clock (staged for a loaded row): the
 * "Timing role" button outside the speaker chip's popover, so an add panel that
 * reuses the same picker is never mistaken for it.
 */
function cardRoleChip() {
  const speakerArea = chip().parentElement;
  const found = screen.getAllByRole('button', { name: /^Timing role/ }).find((b) => !speakerArea.contains(b));
  expect(found, 'the timer card has a role chip').toBeTruthy();
  return found;
}
function chooseCardRole(role) {
  fireEvent.click(cardRoleChip());
  const [option] = screen.getAllByRole('option', { name: new RegExp(`^${role}`) });
  fireEvent.click(option);
}
const cardRole = () => cardRoleChip().getAttribute('aria-label');

/** Opens the add panel and returns its own name field and role control. */
function openAddPanel(pattern = /Add a speaker after Jordan/) {
  const opener = popoverAction(pattern);
  const beforeText = textboxes(body());
  const beforeCombo = within(body()).queryAllByRole('combobox');
  const beforeButtons = within(body()).queryAllByRole('button');
  fireEvent.click(opener);
  const [name] = fresh(textboxes(body()), beforeText);
  expect(name, 'the add panel has its own name field').toBeTruthy();
  const [select] = fresh(within(body()).queryAllByRole('combobox'), beforeCombo);
  const [roleButton] = fresh(within(body()).queryAllByRole('button'), beforeButtons).filter((b) =>
    /role/i.test(b.getAttribute('aria-label') || b.textContent)
  );
  return {
    name,
    roleShown: () => (select ? select.value : roleButton?.getAttribute('aria-label') || roleButton?.textContent || ''),
    chooseRole: (role) => {
      if (select) {
        fireEvent.change(select, { target: { value: role } });
        return;
      }
      expect(roleButton, 'the add panel has its own role').toBeTruthy();
      fireEvent.click(roleButton);
      // Speaker rows are named by the speaker, so the only option named by a
      // role is in the list this button opened.
      const [option] = screen.getAllByRole('option', { name: new RegExp(`^${role}`) });
      fireEvent.click(option);
    },
  };
}

function openSpeakerOptions() {
  openPopover();
  const label = within(body()).queryAllByText(/Speaker options/i)[0];
  expect(label, 'a "Speaker options" control at the foot of the speaker popover').toBeTruthy();
  const toggle = label.closest('button, summary, [role="button"]') || label;
  const details = toggle.closest('details');
  if (details) expect(details.open, '"Speaker options" starts collapsed').toBe(false);
  else if (toggle.hasAttribute('aria-expanded')) expect(toggle.getAttribute('aria-expanded')).toBe('false');
  else expect(within(body()).queryAllByRole('radio', { name: /at the end/i })).toHaveLength(0);
  fireEvent.click(toggle);
  if (details && !details.open) details.open = true;
  const controlled = toggle.getAttribute('aria-controls');
  if (details) return details;
  if (controlled && document.getElementById(controlled)) return document.getElementById(controlled);
  let region = toggle.parentElement;
  while (region && region !== document.body && !region.querySelector('input[type="radio"], input[type="checkbox"], select')) {
    region = region.parentElement;
  }
  return region || body();
}
function settingControls(region, pattern, exclude) {
  const matches = (text) => pattern.test(text) && !(exclude && exclude.test(text));
  const toggles = ['radio', 'checkbox', 'switch'].flatMap((role) =>
    within(region).queryAllByRole(role, { name: (name) => matches(name) })
  );
  const options = [...region.querySelectorAll('select')].flatMap((select) =>
    [...select.options].filter((option) => matches(option.textContent) || matches(option.value)).map((option) => ({ select, option }))
  );
  const buttons = within(region).queryAllByRole('button', { name: (name) => matches(name) && !/speaker options/i.test(name) });
  return { toggles, options, buttons };
}
function choose(region, pattern, exclude) {
  const { toggles, options, buttons } = settingControls(region, pattern, exclude);
  if (toggles.length) fireEvent.click(toggles[0]);
  else if (options.length) fireEvent.change(options[0].select, { target: { value: options[0].option.value } });
  else if (buttons.length) fireEvent.click(buttons[0]);
  else expect.fail(`a "Speaker options" setting matching ${pattern}`);
}
function isChosen(region, pattern, exclude) {
  const { toggles, options, buttons } = settingControls(region, pattern, exclude);
  if (toggles.length) return toggles[0].checked;
  if (options.length) return options[0].select.value === options[0].option.value;
  if (buttons.length) return buttons[0].getAttribute('aria-pressed') === 'true' || buttons[0].getAttribute('aria-checked') === 'true';
  return false;
}
const AT_THE_END = /at the end/i;
const ENTER_ADDS = /\badd/i;
const NOT_INSERT = /end|after/i;

beforeEach(() => {
  localStorage.clear();
  resetFlagsForTests();
  setFlags({ new_look: true, pro: false, sounds: true });
  vi.clearAllMocks();
  getOverlayMode.mockReturnValue('camera');
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'],
  });
  localStorage.setItem('toastmaster_agenda', JSON.stringify(SEED));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('new look, timer card and speaker popover (#168)', () => {
  it('AC-5: the chip carries the status, which is never a button; every action says what it does', () => {
    renderTimerTab();
    expect(shows(body(), 'Not on the agenda')).toBe(true);

    loadJordan();
    openPopover();

    expect(shows(body(), 'On the agenda · 2 of 3')).toBe(true);
    expect(shows(body(), 'Not on the agenda')).toBe(false);
    expectStatusNotAButton(body());
    expect(hasIcon(expectControl(body(), /Switch to quick timing/))).toBe(true);
    expect(shows(body(), 'Jordan stays on the agenda, not ticked off')).toBe(true);
    expect(hasIcon(expectControl(body(), /Add a speaker after Jordan/))).toBe(true);
    expectNoUpdate(body());
  });

  it('AC-6: the popover\'s name field holds Jordan; a new name is staged until Update, which renames him in place', () => {
    renderTimerTab();
    loadJordan();
    const field = openPopover();
    expect(field).toHaveValue('Jordan');

    fireEvent.change(field, { target: { value: 'Dana' } });
    expect(names()).toEqual(['Ana', 'Jordan', 'Cole']);
    expect(ctx.currentSpeaker.name).toBe('Jordan');
    expect(shows(body(), 'Unsaved changes')).toBe(true);
    expect(shows(body(), 'name Jordan → Dana')).toBe(true);

    fireEvent.click(popoverAction(/Update Jordan on the agenda/));

    expect(names()).toEqual(['Ana', 'Dana', 'Cole']);
    expect(ctx.agenda[1].id).toBe('b');
    expect(ctx.currentSpeaker.name).toBe('Dana');
  });

  it('AC-6/AC-8: Enter in the popover\'s name field updates, and adds nobody', () => {
    renderTimerTab();
    loadJordan();
    const field = openPopover();

    fireEvent.change(field, { target: { value: 'Dana' } });
    pressEnter(field);

    expect(names()).toEqual(['Ana', 'Dana', 'Cole']);
    expect(ctx.activeSpeakerId).toBe('b');
  });

  it('AC-6: Undo changes puts the name and the role back, with nothing saved', () => {
    renderTimerTab();
    loadJordan();
    chooseCardRole(TT);
    const field = openPopover();
    fireEvent.change(field, { target: { value: 'Dana' } });

    fireEvent.click(popoverAction(/Undo changes/));

    expect(openPopover()).toHaveValue('Jordan');
    expect(cardRole()).toContain('Ice Breaker');
    expect(shows(body(), 'Unsaved changes')).toBe(false);
    expect(ctx.agenda[1]).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
  });

  it('AC-9: the card\'s role chip stages the role; Update lists both changes and writes them, with the rules, to the row and the clock', () => {
    renderTimerTab();
    loadJordan();

    chooseCardRole(TT);
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker', rules: RULES['Ice Breaker'] });
    expect(ctx.agenda[1]).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });

    const field = openPopover();
    fireEvent.change(field, { target: { value: 'Dana' } });
    expect(shows(body(), 'name Jordan → Dana · role → Table Topics Speech')).toBe(true);

    fireEvent.click(popoverAction(/Update Jordan on the agenda/));

    expect(ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Dana', role: TT, rules: RULES[TT] });
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Dana', role: TT, rules: RULES[TT] });
  });

  it('AC-9: Take a Break from the role chip still lets go of Jordan at once', () => {
    renderTimerTab();
    loadJordan();

    chooseCardRole(BREAK_ROLE);

    expect(ctx.activeSpeakerId).toBeNull();
    expect(ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Jordan', role: 'Ice Breaker', completed: false });
  });

  it('AC-7/AC-1: the add panel has its own name and role (the clock\'s); Add puts Dana after Jordan and loads her', () => {
    renderTimerTab();
    loadJordan();

    const panel = openAddPanel();
    expect(panel.roleShown()).toContain('Ice Breaker');
    fireEvent.change(panel.name, { target: { value: 'Dana' } });
    expect(ctx.currentSpeaker.name).toBe('Jordan');
    expect(names()).toEqual(['Ana', 'Jordan', 'Cole']);

    fireEvent.click(expectControl(body(), /Add Dana after Jordan/));

    expect(names()).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    expect(ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Jordan', role: 'Ice Breaker' });
    expect(ctx.activeSpeakerId).toBe(row('Dana').id);
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Dana', role: 'Ice Breaker' });
  });

  it('AC-10: the add panel\'s role leaves the clock and Jordan alone, is named on Add, and gives Dana its rules', () => {
    renderTimerTab();
    loadJordan();
    const panel = openAddPanel();

    panel.chooseRole(TT);
    fireEvent.change(panel.name, { target: { value: 'Dana' } });

    expect(ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
    expect(cardRole()).toContain('Ice Breaker');
    expect(ctx.agenda[1]).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
    const add = expectControl(body(), /Add Dana after Jordan/);
    expect(squash(add.textContent)).toContain(squash('as Table Topics Speech'));

    fireEvent.click(add);

    expect(row('Dana')).toMatchObject({ role: TT, rules: RULES[TT] });
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Dana', role: TT, rules: RULES[TT] });
  });

  it('AC-8: Enter in the add panel adds', () => {
    renderTimerTab();
    loadJordan();
    const panel = openAddPanel();

    fireEvent.change(panel.name, { target: { value: 'Dana' } });
    pressEnter(panel.name);

    expect(names()).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
  });

  it('AC-8: with nothing loaded, Enter in the popover\'s name field adds nobody, under either setting', () => {
    for (const setting of ['update', 'add']) {
      localStorage.setItem('toastmaster_agenda', JSON.stringify(SEED));
      localStorage.setItem(ENTER_KEY, setting);
      const view = renderTimerTab();
      const field = openPopover();

      fireEvent.change(field, { target: { value: 'Dana' } });
      pressEnter(field);

      expect(names(), setting).toEqual(['Ana', 'Jordan', 'Cole']);
      expect(ctx.activeSpeakerId, setting).toBeNull();
      view.unmount();
      localStorage.clear();
    }
  });

  it('AC-8: with Enter on "add", a new name offers "Add Dana after Jordan" beside Update, and Enter adds; Jordan is unchanged', () => {
    localStorage.setItem(ENTER_KEY, 'add');
    renderTimerTab();
    loadJordan();
    const field = openPopover();

    fireEvent.change(field, { target: { value: 'Dana' } });
    expectControl(body(), /Add Dana after Jordan/);
    expectControl(body(), /Update Jordan on the agenda/);
    pressEnter(field);

    expect(names()).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    expect(ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Jordan' });
  });

  it('AC-2: with the setting on "at the end", Dana goes last and is loaded', () => {
    localStorage.setItem(INSERT_KEY, 'end');
    renderTimerTab();
    loadJordan();
    const panel = openAddPanel(/Add a speaker/);

    fireEvent.change(panel.name, { target: { value: 'Dana' } });
    fireEvent.click(expectControl(body(), /Add Dana/));

    expect(names()).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);
    expect(ctx.activeSpeakerId).toBe(row('Dana').id);
  });

  it('AC-3/AC-15: with nothing loaded, the typed name labels the timer, and "Save Dana to the agenda" puts her last and loads her', () => {
    for (const setting of ['afterActive', 'end']) {
      localStorage.setItem('toastmaster_agenda', JSON.stringify(SEED));
      localStorage.setItem(INSERT_KEY, setting);
      const view = renderTimerTab();
      const field = openPopover();

      fireEvent.change(field, { target: { value: 'Dana' } });
      expect(ctx.currentSpeaker.name, setting).toBe('Dana');

      fireEvent.click(popoverAction(/Save Dana to the agenda/));

      expect(names(), setting).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);
      expect(ctx.activeSpeakerId, setting).toBe(row('Dana').id);
      view.unmount();
      localStorage.clear();
    }
  });

  it('AC-13: added while Jordan\'s speech runs, Dana waits: the timer, chip and video are untouched; Finish moves to her', () => {
    renderTimerTab();
    loadJordan();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    tick(2000);
    const elapsed = ctx.elapsedTime;
    expect(elapsed).toBeGreaterThan(0);
    applyOverlay.mockClear();
    removeOverlay.mockClear();

    const panel = openAddPanel();
    fireEvent.change(panel.name, { target: { value: 'Dana' } });
    fireEvent.click(expectControl(body(), /Add Dana after Jordan/));

    expect(names()).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    expect(ctx.activeSpeakerId).toBe('b');
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker', rules: RULES['Ice Breaker'] });
    expect(ctx.isRunning).toBe(true);
    expect(ctx.elapsedTime).toBeGreaterThanOrEqual(elapsed);
    expect(chip().getAttribute('aria-label') || chip().textContent).toContain('Jordan');
    expect(applyOverlay).not.toHaveBeenCalled();
    expect(removeOverlay).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(ctx.activeSpeakerId).toBe(row('Dana').id);
  });

  it('AC-14: "Switch to quick timing" lets go of Jordan; the name labels the timer; Finish reports it, the agenda unchanged; "Back to agenda" returns', () => {
    renderTimerTab();
    loadJordan();

    fireEvent.click(popoverAction(/Switch to quick timing/));
    expect(ctx.activeSpeakerId).toBeNull();
    expect(ctx.agenda[1]).toMatchObject({ id: 'b', completed: false });
    expect(shows(body(), 'Not on the agenda')).toBe(true);
    popoverAction(/Back to agenda/);
    expect(shows(body(), 'next: Jordan, Ice Breaker')).toBe(true);

    fireEvent.change(openPopover(), { target: { value: 'Guest' } });
    expect(ctx.currentSpeaker.name).toBe('Guest');

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    tick(2000);
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(ctx.reports.at(-1)).toMatchObject({ name: 'Guest' });
    expect(names()).toEqual(['Ana', 'Jordan', 'Cole']);
    expect(ctx.agenda.every((item) => !item.completed)).toBe(true);
  });

  it('AC-14: "Back to agenda" loads Jordan again', () => {
    renderTimerTab();
    loadJordan();
    fireEvent.click(popoverAction(/Switch to quick timing/));

    fireEvent.click(popoverAction(/Back to agenda/));

    expect(ctx.activeSpeakerId).toBe('b');
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
  });

  it('AC-15: a quick-timed name is saved after the row let go of, with the role shown, and loaded', () => {
    renderTimerTab();
    loadJordan();
    fireEvent.click(popoverAction(/Switch to quick timing/));
    fireEvent.change(openPopover(), { target: { value: 'Eve' } });
    const shown = cardRole();

    fireEvent.click(popoverAction(/Save Eve to the agenda/));

    expect(names()).toEqual(['Ana', 'Jordan', 'Eve', 'Cole']);
    expect(shown).toContain(row('Eve').role);
    expect(ctx.activeSpeakerId).toBe(row('Eve').id);
  });

  it('AC-16: Start never adds or changes an agenda row', () => {
    renderTimerTab();
    fireEvent.change(openPopover(), { target: { value: 'Guest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(names()).toEqual(['Ana', 'Jordan', 'Cole']);
    expect(ctx.activeSpeakerId).toBeNull();
  });

  it('AC-4: "Speaker options" sits collapsed at the foot of the popover, and both settings are saved and shown again', () => {
    const view = renderTimerTab();
    let region = openSpeakerOptions();

    choose(region, AT_THE_END);
    choose(region, ENTER_ADDS, NOT_INSERT);
    expect(localStorage.getItem(INSERT_KEY)).toBe('end');
    expect(localStorage.getItem(ENTER_KEY)).toBe('add');

    view.unmount();
    renderTimerTab();
    region = openSpeakerOptions();
    expect(isChosen(region, AT_THE_END)).toBe(true);
    expect(isChosen(region, ENTER_ADDS, NOT_INSERT)).toBe(true);
  });

  it('AC-11: the shared sequence ends on the same agenda and clock as every other surface', () => {
    renderTimerTab();
    loadJordan();
    const panel = openAddPanel();
    panel.chooseRole(TT);
    fireEvent.change(panel.name, { target: { value: 'Dana' } });
    fireEvent.click(expectControl(body(), /Add Dana after Jordan/));
    tick(10);
    fireEvent.change(openPopover(), { target: { value: 'Dane' } });
    fireEvent.click(popoverAction(/Update Dana on the agenda/));
    fireEvent.click(popoverAction(/Switch to quick timing/));
    fireEvent.change(openPopover(), { target: { value: 'Eve' } });
    tick(10);
    fireEvent.click(popoverAction(/Save Eve to the agenda/));

    expect(names()).toEqual(['Ana', 'Jordan', 'Dane', 'Eve', 'Cole']);
    expect(ctx.agenda.map((item) => item.role)).toEqual(['Standard Speech', 'Ice Breaker', TT, TT, 'Standard Speech']);
    expect(ctx.activeSpeakerId).toBe(row('Eve').id);
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Eve', role: TT, rules: RULES[TT] });
  });
});

describe('new look, full-screen stage (#168)', () => {
  // TimerStage mounts the same StageSpeakerPicker for both looks, wired to the
  // same hook; this proves the wiring under design B.
  const stage = () => screen.getByTestId('timer-stage');
  const stageField = () => textboxes(stage())[0];

  beforeEach(() => {
    getOverlayMode.mockReturnValue('stage');
  });

  it('AC-5/AC-6/AC-7: status, a staged rename with Update, and "+ Add" after Jordan', () => {
    renderTimerTab();
    loadJordan();
    expect(shows(stage(), 'On the agenda · 2 of 3')).toBe(true);

    fireEvent.change(stageField(), { target: { value: 'Dana' } });
    expect(ctx.currentSpeaker.name).toBe('Jordan');
    fireEvent.click(expectControl(stage(), /Update Jordan on the agenda/));
    expect(names()).toEqual(['Ana', 'Dana', 'Cole']);

    const [opener] = within(stage()).queryAllByRole('button', {
      name: (name) => /add a speaker/i.test(name) || /^\W*add$/i.test(name.trim()),
    });
    expect(opener, 'the stage offers "+ Add"').toBeTruthy();
    const before = textboxes(stage());
    fireEvent.click(opener);
    const [addName] = fresh(textboxes(stage()), before);
    expect(addName, 'the stage\'s add panel has its own name field').toBeTruthy();
    fireEvent.change(addName, { target: { value: 'Eve' } });
    fireEvent.click(expectControl(stage(), /Add Eve after Dana/));
    expect(names()).toEqual(['Ana', 'Dana', 'Eve', 'Cole']);
  });
});
