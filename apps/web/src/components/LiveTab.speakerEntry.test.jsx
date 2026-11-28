import { screen, fireEvent, act, within } from '@testing-library/react';
import LiveTab from './LiveTab';
import { renderWithProviders } from '../test/helpers';
import { useTimer, useTimerTick } from '../context/TimerContext';
import { DEFAULT_ROLE_RULES } from '@toastmaster-timer/shared';

/**
 * #168, on-the-spot speakers, on the web Live tab. The web follows the Zoom app
 * (decision Q6, AC-12): the same status, the same staged Update with Undo, the
 * same add panel, quick timing and Back to agenda, the same two settings (synced
 * with the Zoom app), and picking an agenda suggestion loads its row. The same
 * steps and words as apps/zoom-app/src/components/LiveTab.speakerEntry.test.jsx,
 * read through the timer context. The web has no stage.
 */

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
const TT_RULES_LINE = 'Timing rules: Green: 1 minute, Yellow: 1 min 30 sec, Red: 2 minutes';
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
const renderLive = () => renderWithProviders(<><Probe /><LiveTab /></>);

const names = () => ctx.agenda.map((item) => item.name);
const row = (name) => ctx.agenda.find((item) => item.name === name);
const loadJordan = () => act(() => ctx.loadSpeakerFromAgenda('b'));
const tick = (ms) => act(() => {
  vi.advanceTimersByTime(ms);
});
const body = () => document.body;
const nameField = () => screen.getByPlaceholderText('Type speaker name...');
const rolePicker = () => screen.getAllByRole('combobox')[0];

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
const comboboxes = (scope) => within(scope).queryAllByRole('combobox');
const fresh = (after, before) => after.filter((el) => !before.includes(el));

function openAddPanel(pattern = /Add a speaker after Jordan/) {
  const opener = expectControl(body(), pattern);
  const beforeText = textboxes(body());
  const beforeCombo = comboboxes(body());
  fireEvent.click(opener);
  const [name] = fresh(textboxes(body()), beforeText);
  expect(name, 'the add panel has its own name field').toBeTruthy();
  const [role] = fresh(comboboxes(body()), beforeCombo);
  return { name, role };
}

function openSpeakerOptions(scope) {
  const label = within(scope).queryAllByText(/Speaker options/i)[0];
  expect(label, 'a "Speaker options" control').toBeTruthy();
  const toggle = label.closest('button, summary, [role="button"]') || label;
  const details = toggle.closest('details');
  if (details) expect(details.open, '"Speaker options" starts collapsed').toBe(false);
  else if (toggle.hasAttribute('aria-expanded')) expect(toggle.getAttribute('aria-expanded')).toBe('false');
  else expect(within(scope).queryAllByRole('radio', { name: /at the end/i })).toHaveLength(0);
  fireEvent.click(toggle);
  if (details && !details.open) details.open = true;
  const controlled = toggle.getAttribute('aria-controls');
  if (details) return details;
  if (controlled && document.getElementById(controlled)) return document.getElementById(controlled);
  let region = toggle.parentElement;
  while (region && region !== document.body && !region.querySelector('input[type="radio"], input[type="checkbox"], select')) {
    region = region.parentElement;
  }
  return region || scope;
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
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'],
  });
  localStorage.setItem('toastmaster_agenda', JSON.stringify(SEED));
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('web Live tab: on-the-spot speakers (#168)', () => {
  it('AC-12: picking an agenda suggestion loads its row, as in the Zoom app', () => {
    renderLive();

    fireEvent.focus(nameField());
    fireEvent.mouseDown(screen.getByText('Jordan'));

    expect(ctx.activeSpeakerId).toBe('b');
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
    expect(shows(body(), 'On the agenda · 2 of 3')).toBe(true);
  });

  it('AC-5: the status is a dot, not a button, and every action says what tapping it does', () => {
    renderLive();
    expect(shows(body(), 'Not on the agenda')).toBe(true);
    expectStatusNotAButton(body());

    loadJordan();

    expect(shows(body(), 'On the agenda · 2 of 3')).toBe(true);
    expect(shows(body(), 'Not on the agenda')).toBe(false);
    expectStatusNotAButton(body());
    expect(hasIcon(expectControl(body(), /Switch to quick timing/))).toBe(true);
    expect(shows(body(), 'Jordan stays on the agenda, not ticked off')).toBe(true);
    expect(hasIcon(expectControl(body(), /Add a speaker after Jordan/))).toBe(true);
    expectNoUpdate(body());
  });

  it('AC-6: a new name changes nothing until "Update Jordan on the agenda", which renames him in place', () => {
    renderLive();
    loadJordan();

    fireEvent.change(nameField(), { target: { value: 'Dana' } });
    expect(names()).toEqual(['Ana', 'Jordan', 'Cole']);
    expect(ctx.currentSpeaker.name).toBe('Jordan');
    expect(shows(body(), 'Unsaved changes')).toBe(true);
    expect(shows(body(), 'name Jordan → Dana')).toBe(true);

    fireEvent.click(expectControl(body(), /Update Jordan on the agenda/));

    expect(names()).toEqual(['Ana', 'Dana', 'Cole']);
    expect(ctx.agenda[1].id).toBe('b');
    expect(ctx.activeSpeakerId).toBe('b');
    expect(ctx.currentSpeaker.name).toBe('Dana');
    expect(shows(body(), 'Unsaved changes')).toBe(false);
  });

  it('AC-6/AC-8: Enter in the name field does what Update does', () => {
    renderLive();
    loadJordan();

    fireEvent.change(nameField(), { target: { value: 'Dana' } });
    expect(ctx.currentSpeaker.name).toBe('Jordan');
    pressEnter(nameField());

    expect(names()).toEqual(['Ana', 'Dana', 'Cole']);
    expect(ctx.currentSpeaker.name).toBe('Dana');
  });

  it('AC-6: Undo changes puts the name and role back, with nothing saved', () => {
    renderLive();
    loadJordan();
    fireEvent.change(nameField(), { target: { value: 'Dana' } });
    fireEvent.change(rolePicker(), { target: { value: TT } });

    fireEvent.click(expectControl(body(), /Undo changes/));

    expect(nameField()).toHaveValue('Jordan');
    expect(rolePicker()).toHaveValue('Ice Breaker');
    expect(shows(body(), 'Unsaved changes')).toBe(false);
    expect(ctx.agenda[1]).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
  });

  it('AC-9: name and role are staged together; Update lists both and writes both, with the rules, to the row and the clock', () => {
    renderLive();
    loadJordan();

    fireEvent.change(rolePicker(), { target: { value: TT } });
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker', rules: RULES['Ice Breaker'] });
    expect(ctx.agenda[1]).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });

    fireEvent.change(nameField(), { target: { value: 'Dana' } });
    expect(shows(body(), 'name Jordan → Dana · role → Table Topics Speech')).toBe(true);

    fireEvent.click(expectControl(body(), /Update Jordan on the agenda/));

    expect(ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Dana', role: TT, rules: RULES[TT] });
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Dana', role: TT, rules: RULES[TT] });
    expect(screen.getByText(TT_RULES_LINE)).toBeInTheDocument();
  });

  it('AC-7/AC-1: the add panel has its own name and role (the clock\'s), and Add puts Dana after Jordan and loads her', () => {
    renderLive();
    loadJordan();

    const panel = openAddPanel();
    expect(panel.role, 'the add panel has its own role').toBeTruthy();
    expect(panel.role).toHaveValue('Ice Breaker');
    fireEvent.change(panel.name, { target: { value: 'Dana' } });
    expect(nameField()).toHaveValue('Jordan');
    expect(ctx.currentSpeaker.name).toBe('Jordan');
    expect(names()).toEqual(['Ana', 'Jordan', 'Cole']);

    fireEvent.click(expectControl(body(), /Add Dana after Jordan/));

    expect(names()).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    expect(ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Jordan', role: 'Ice Breaker' });
    expect(ctx.activeSpeakerId).toBe(row('Dana').id);
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Dana', role: 'Ice Breaker', rules: RULES['Ice Breaker'] });
    expect(shows(body(), 'On the agenda · 3 of 4')).toBe(true);
  });

  it('AC-10: the add panel\'s role is its own: the clock and Jordan keep theirs, Add names it, and Dana gets its rules', () => {
    renderLive();
    loadJordan();
    const panel = openAddPanel();
    expect(panel.role, 'the add panel has its own role').toBeTruthy();

    fireEvent.change(panel.role, { target: { value: TT } });
    fireEvent.change(panel.name, { target: { value: 'Dana' } });

    expect(ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
    expect(rolePicker()).toHaveValue('Ice Breaker');
    expect(ctx.agenda[1]).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
    const add = expectControl(body(), /Add Dana after Jordan/);
    expect(squash(add.textContent)).toContain(squash('as Table Topics Speech'));

    fireEvent.click(add);

    expect(row('Dana')).toMatchObject({ role: TT, rules: RULES[TT] });
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Dana', role: TT, rules: RULES[TT] });
    expect(screen.getByText(TT_RULES_LINE)).toBeInTheDocument();
  });

  it('AC-8: Enter in the add panel adds', () => {
    renderLive();
    loadJordan();
    const panel = openAddPanel();

    fireEvent.change(panel.name, { target: { value: 'Dana' } });
    pressEnter(panel.name);

    expect(names()).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
  });

  it('AC-2: with the setting on "at the end", Dana goes last and is loaded', () => {
    localStorage.setItem(INSERT_KEY, 'end');
    renderLive();
    loadJordan();
    const panel = openAddPanel(/Add a speaker/);

    fireEvent.change(panel.name, { target: { value: 'Dana' } });
    fireEvent.click(expectControl(body(), /Add Dana/));

    expect(names()).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);
    expect(ctx.activeSpeakerId).toBe(row('Dana').id);
  });

  it('AC-3/AC-15: with nothing loaded, a typed name labels the timer, and "Save Dana to the agenda" puts her last and loads her, whichever setting is on', () => {
    for (const setting of ['afterActive', 'end']) {
      localStorage.setItem('toastmaster_agenda', JSON.stringify(SEED));
      localStorage.setItem(INSERT_KEY, setting);
      const view = renderLive();

      fireEvent.change(nameField(), { target: { value: 'Dana' } });
      expect(ctx.currentSpeaker.name, setting).toBe('Dana');

      fireEvent.click(expectControl(body(), /Save Dana to the agenda/));

      expect(names(), setting).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);
      expect(ctx.activeSpeakerId, setting).toBe(row('Dana').id);
      view.unmount();
      localStorage.clear();
    }
  });

  it('AC-8: with nothing loaded, Enter in the name field does nothing, under either setting', () => {
    for (const setting of ['update', 'add']) {
      localStorage.setItem('toastmaster_agenda', JSON.stringify(SEED));
      localStorage.setItem(ENTER_KEY, setting);
      const view = renderLive();

      fireEvent.change(nameField(), { target: { value: 'Dana' } });
      pressEnter(nameField());

      expect(names(), setting).toEqual(['Ana', 'Jordan', 'Cole']);
      expect(ctx.activeSpeakerId, setting).toBeNull();
      // Typing with nothing loaded is a quick timing: it labels the timer.
      expect(ctx.currentSpeaker.name, setting).toBe('Dana');
      expect(shows(body(), 'Save Dana to the agenda'), setting).toBe(true);
      view.unmount();
      localStorage.clear();
    }
  });

  it('AC-8: with Enter on "add", a new name makes "Add Dana after Jordan" the primary action beside Update, and Enter adds', () => {
    localStorage.setItem(ENTER_KEY, 'add');
    renderLive();
    loadJordan();

    fireEvent.change(nameField(), { target: { value: 'Dana' } });
    expectControl(body(), /Add Dana after Jordan/);
    expectControl(body(), /Update Jordan on the agenda/);
    pressEnter(nameField());

    expect(names()).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    expect(ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Jordan', role: 'Ice Breaker' });
  });

  it('AC-13: added while Jordan\'s speech runs, Dana is inserted but the timer and label stay; FINISH moves to her', () => {
    renderLive();
    loadJordan();
    fireEvent.click(screen.getByRole('button', { name: /START/ }));
    tick(2000);
    const elapsed = ctx.elapsedTime;
    expect(elapsed).toBeGreaterThan(0);

    const panel = openAddPanel();
    fireEvent.change(panel.name, { target: { value: 'Dana' } });
    fireEvent.click(expectControl(body(), /Add Dana after Jordan/));

    expect(names()).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    expect(ctx.activeSpeakerId).toBe('b');
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker', rules: RULES['Ice Breaker'] });
    expect(ctx.isRunning).toBe(true);
    expect(ctx.elapsedTime).toBeGreaterThanOrEqual(elapsed);
    expect(nameField()).toHaveValue('Jordan');

    fireEvent.click(screen.getByRole('button', { name: /FINISH/ }));

    expect(ctx.activeSpeakerId).toBe(row('Dana').id);
    expect(nameField()).toHaveValue('Dana');
  });

  it('AC-14: "Switch to quick timing" lets go of Jordan; the name labels the timer; FINISH reports it with the agenda unchanged', () => {
    renderLive();
    loadJordan();

    fireEvent.click(expectControl(body(), /Switch to quick timing/));

    expect(ctx.activeSpeakerId).toBeNull();
    expect(ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Jordan', completed: false });
    expect(shows(body(), 'Not on the agenda')).toBe(true);
    expectControl(body(), /Back to agenda/);
    expect(shows(body(), 'next: Jordan, Ice Breaker')).toBe(true);

    fireEvent.change(nameField(), { target: { value: 'Guest' } });
    expect(ctx.currentSpeaker.name).toBe('Guest');

    fireEvent.click(screen.getByRole('button', { name: /START/ }));
    tick(2000);
    fireEvent.click(screen.getByRole('button', { name: /FINISH/ }));

    expect(ctx.reports.at(-1)).toMatchObject({ name: 'Guest' });
    expect(names()).toEqual(['Ana', 'Jordan', 'Cole']);
    expect(ctx.agenda.every((item) => !item.completed)).toBe(true);
  });

  it('AC-14: "Back to agenda" loads Jordan again', () => {
    renderLive();
    loadJordan();
    fireEvent.click(expectControl(body(), /Switch to quick timing/));

    fireEvent.click(expectControl(body(), /Back to agenda/));

    expect(ctx.activeSpeakerId).toBe('b');
    expect(nameField()).toHaveValue('Jordan');
    expect(rolePicker()).toHaveValue('Ice Breaker');
  });

  it('AC-15: a quick-timed name is saved after the row let go of, with the role shown, and loaded; during a speech, not loaded', () => {
    renderLive();
    loadJordan();
    fireEvent.click(expectControl(body(), /Switch to quick timing/));
    fireEvent.change(nameField(), { target: { value: 'Eve' } });
    const shownRole = rolePicker().value;

    fireEvent.click(expectControl(body(), /Save Eve to the agenda/));

    expect(names()).toEqual(['Ana', 'Jordan', 'Eve', 'Cole']);
    expect(row('Eve').role).toBe(shownRole);
    expect(ctx.activeSpeakerId).toBe(row('Eve').id);

    // Let go of Eve, time a guest, and save them mid-speech.
    fireEvent.click(expectControl(body(), /Switch to quick timing/));
    fireEvent.change(nameField(), { target: { value: 'Finn' } });
    fireEvent.click(screen.getByRole('button', { name: /START/ }));
    tick(2000);
    fireEvent.click(expectControl(body(), /Save Finn to the agenda/));

    expect(names()).toEqual(['Ana', 'Jordan', 'Eve', 'Finn', 'Cole']);
    expect(ctx.activeSpeakerId).toBeNull();
    expect(ctx.isRunning).toBe(true);
  });

  it('AC-16: START never adds or changes an agenda row', () => {
    renderLive();
    fireEvent.change(nameField(), { target: { value: 'Guest' } });
    fireEvent.click(screen.getByRole('button', { name: /START/ }));
    expect(names()).toEqual(['Ana', 'Jordan', 'Cole']);
    expect(ctx.activeSpeakerId).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /STOP/ }));
    fireEvent.click(screen.getByRole('button', { name: /RESET/ }));

    loadJordan();
    fireEvent.change(nameField(), { target: { value: 'Dana' } });
    fireEvent.click(screen.getByRole('button', { name: /START/ }));
    expect(ctx.agenda).toHaveLength(3);
    expect(ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Jordan', role: 'Ice Breaker' });
  });

  it('AC-4/AC-12: "Speaker options" starts collapsed under the name field; both settings are saved and shown again', () => {
    const view = renderLive();
    let region = openSpeakerOptions(body());

    choose(region, AT_THE_END);
    choose(region, ENTER_ADDS, NOT_INSERT);
    expect(localStorage.getItem(INSERT_KEY)).toBe('end');
    expect(localStorage.getItem(ENTER_KEY)).toBe('add');

    view.unmount();
    renderLive();
    region = openSpeakerOptions(body());
    expect(isChosen(region, AT_THE_END)).toBe(true);
    expect(isChosen(region, ENTER_ADDS, NOT_INSERT)).toBe(true);
  });

  it('AC-11: the shared sequence ends on the same agenda and clock as every other surface', () => {
    renderLive();
    loadJordan();
    const panel = openAddPanel();
    expect(panel.role, 'the add panel has its own role').toBeTruthy();
    fireEvent.change(panel.role, { target: { value: TT } });
    fireEvent.change(panel.name, { target: { value: 'Dana' } });
    fireEvent.click(expectControl(body(), /Add Dana after Jordan/));
    tick(10);
    fireEvent.change(nameField(), { target: { value: 'Dane' } });
    fireEvent.click(expectControl(body(), /Update Dana on the agenda/));
    fireEvent.click(expectControl(body(), /Switch to quick timing/));
    fireEvent.change(nameField(), { target: { value: 'Eve' } });
    tick(10);
    fireEvent.click(expectControl(body(), /Save Eve to the agenda/));

    expect(names()).toEqual(['Ana', 'Jordan', 'Dane', 'Eve', 'Cole']);
    expect(ctx.agenda.map((item) => item.role)).toEqual(['Standard Speech', 'Ice Breaker', TT, TT, 'Standard Speech']);
    expect(ctx.activeSpeakerId).toBe(row('Eve').id);
    expect(ctx.currentSpeaker).toMatchObject({ name: 'Eve', role: TT, rules: RULES[TT] });
  });
});
