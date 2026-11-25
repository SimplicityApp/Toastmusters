import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LiveTab from './LiveTab';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider, useTimer, useTimerTick } from '../context/TimerContext';
import { DEFAULT_ROLE_RULES } from '@toastmaster-timer/shared';

/**
 * #168 on the web, what the speaker model must keep beyond the oracle, as in the
 * Zoom app (useLiveTimer.speakerState.test.jsx): the Live tab unmounts on every
 * tab switch (TimerApp.jsx) while the timer context stays, so a staged edit and
 * the row let go of for a quick timing survive a trip to the Agenda or Report
 * tab. START keeps a staged edit, the rules line says the clock's role, and
 * "Back to agenda" never resets a quick timing in progress.
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
const IB_RULES_LINE = 'Timing rules: Green: 4 minutes, Yellow: 5 minutes, Red: 6 minutes';
const TT_RULES_LINE = 'Timing rules: Green: 1 minute, Yellow: 1 min 30 sec, Red: 2 minutes';

const ctx = {};
function Shell({ tab }) {
  Object.assign(ctx, useTimer(), useTimerTick());
  return tab === 'live' ? <LiveTab /> : <p>Another tab</p>;
}
const tree = (tab) => (
  <MemoryRouter>
    <ToastProvider>
      <TimerProvider>
        <Shell tab={tab} />
      </TimerProvider>
    </ToastProvider>
  </MemoryRouter>
);
function renderLive() {
  const view = render(tree('live'));
  return {
    switchTabs: () => {
      view.rerender(tree('report'));
      view.rerender(tree('live'));
    },
  };
}

const names = () => ctx.agenda.map((item) => item.name);
const nameField = () => screen.getByPlaceholderText('Type speaker name...');
const rolePicker = () => screen.getAllByRole('combobox')[0];
const button = (name) => screen.queryByRole('button', { name });
const loadJordan = () => act(() => ctx.loadSpeakerFromAgenda('b'));
const tick = (ms) => act(() => {
  vi.advanceTimersByTime(ms);
});

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

describe('web Live tab: speaker state across tab switches and START (#168)', () => {
  it('keeps an edit staged for Update through a tab switch, and Update still writes it', () => {
    const { switchTabs } = renderLive();
    loadJordan();
    fireEvent.change(nameField(), { target: { value: 'Dana' } });
    fireEvent.change(rolePicker(), { target: { value: TT } });

    switchTabs();

    expect(nameField()).toHaveValue('Dana');
    expect(rolePicker()).toHaveValue(TT);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(button(/Update Jordan on the agenda/));
    expect(ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Dana', role: TT, rules: RULES[TT] });
  });

  it('keeps the row let go of for a quick timing through a tab switch', () => {
    const { switchTabs } = renderLive();
    loadJordan();
    fireEvent.click(button(/Switch to quick timing/));
    fireEvent.change(nameField(), { target: { value: 'Guest' } });
    fireEvent.click(button(/START/));
    tick(2000);
    fireEvent.click(button(/FINISH/));

    switchTabs();

    expect(ctx.reports.at(-1)).toMatchObject({ name: 'Guest' });
    expect(button(/Back to agenda/)).not.toBeNull();
    fireEvent.change(nameField(), { target: { value: 'Eve' } });
    fireEvent.click(button(/Save Eve to the agenda/));
    expect(names()).toEqual(['Ana', 'Jordan', 'Eve', 'Cole']);
  });

  it('START keeps an edit staged for Update; the rules line says the clock\'s role until Update', () => {
    renderLive();
    loadJordan();
    fireEvent.change(rolePicker(), { target: { value: TT } });
    expect(screen.getByText(IB_RULES_LINE)).toBeInTheDocument();

    fireEvent.click(button(/START/));
    tick(1000);

    expect(ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
    expect(rolePicker()).toHaveValue(TT);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    fireEvent.click(button(/Update Jordan on the agenda/));
    expect(ctx.agenda[1]).toMatchObject({ name: 'Jordan', role: TT, rules: RULES[TT] });
    expect(screen.getByText(TT_RULES_LINE)).toBeInTheDocument();
  });

  it('offers no "Back to agenda" while the quick timing runs or is paused', () => {
    renderLive();
    loadJordan();
    fireEvent.click(button(/Switch to quick timing/));
    fireEvent.change(nameField(), { target: { value: 'Guest' } });
    fireEvent.click(button(/START/));
    tick(2000);
    expect(button(/Back to agenda/)).toBeNull();

    fireEvent.click(button(/STOP/));
    expect(button(/Back to agenda/)).toBeNull();

    fireEvent.click(button(/FINISH/));
    expect(button(/Back to agenda/)).not.toBeNull();
  });

  it('never offers to save a name that is already on the agenda', () => {
    renderLive();
    fireEvent.change(nameField(), { target: { value: 'cole' } });
    expect(button(/Save cole to the agenda/)).toBeNull();
    fireEvent.change(nameField(), { target: { value: 'Dana' } });
    expect(button(/Save Dana to the agenda/)).not.toBeNull();
  });
});
