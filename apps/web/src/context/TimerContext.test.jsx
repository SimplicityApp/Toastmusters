import { renderHook, act } from '@testing-library/react';
import { ToastProvider } from './ToastContext';
import { TimerProvider, useTimer, useTimerTick } from './TimerContext';
import { setPageBackgroundFromStatus } from '../utils/pageBackground';
import { trackEvent } from '../utils/posthog';

// Convenience hook for tests: merges both contexts into one object so all
// existing test assertions continue to work without modification.
function useAllTimer() {
  return { ...useTimer(), ...useTimerTick() };
}

function wrapper({ children }) {
  return (
    <ToastProvider>
      <TimerProvider>{children}</TimerProvider>
    </ToastProvider>
  );
}

// Speaker with Short Roles rules for concise timing tests
const SHORT_ROLES_SPEAKER = {
  name: 'Alice',
  role: 'Short Roles',
  rules: { green: 30, yellow: 45, red: 60, graceAfterRed: 15 },
};

describe('TimerContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    it('has correct default values', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      expect(result.current.isRunning).toBe(false);
      expect(result.current.elapsedTime).toBe(0);
      expect(result.current.currentStatus).toBe('blue');
      expect(result.current.currentSpeaker).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // startTimer
  // ---------------------------------------------------------------------------
  describe('startTimer', () => {
    it('does NOT start when currentSpeaker is null (no rules)', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.startTimer();
      });

      expect(result.current.isRunning).toBe(false);
    });

    it('starts when a speaker with rules is set', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      expect(result.current.isRunning).toBe(true);
    });

    it('calls setPageBackgroundFromStatus with initial status on start', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      vi.clearAllMocks();

      act(() => {
        result.current.startTimer();
      });

      expect(setPageBackgroundFromStatus).toHaveBeenCalledWith('blue');
    });
  });

  // ---------------------------------------------------------------------------
  // Timer ticks (fake timers)
  // ---------------------------------------------------------------------------
  describe('timer ticks', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('increments elapsedTime by ~1 after 1000ms', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // Ticks 10 times at 0.1s each = 1 second total (floating point, use approx)
      expect(result.current.elapsedTime).toBeCloseTo(1, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // stopTimer
  // ---------------------------------------------------------------------------
  describe('stopTimer', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops the timer while preserving elapsedTime', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      const timeBeforeStop = result.current.elapsedTime;

      act(() => {
        result.current.stopTimer();
      });

      expect(result.current.isRunning).toBe(false);
      expect(result.current.elapsedTime).toBeCloseTo(timeBeforeStop, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // stopTimer -> startTimer (continue): regression for resume-from-zero bug
  // ---------------------------------------------------------------------------
  describe('stopTimer -> startTimer (continue)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('continues from the paused elapsed time on resume', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      act(() => {
        result.current.stopTimer();
      });

      expect(result.current.elapsedTime).toBeCloseTo(5, 0);

      act(() => {
        result.current.startTimer();
      });

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(result.current.elapsedTime).toBeCloseTo(8, 0);
    });

    it('preserves elapsed time across multiple stop/continue cycles', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      act(() => {
        result.current.stopTimer();
      });

      act(() => {
        result.current.startTimer();
      });

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      act(() => {
        result.current.stopTimer();
      });

      act(() => {
        result.current.startTimer();
      });

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(result.current.elapsedTime).toBeCloseTo(12, 0);
    });

    it('starts fresh from 0 when reset is called after stop', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      act(() => {
        result.current.stopTimer();
      });

      act(() => {
        result.current.resetTimer();
      });

      expect(result.current.elapsedTime).toBe(0);

      act(() => {
        result.current.startTimer();
      });

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(result.current.elapsedTime).toBeCloseTo(2, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // resetTimer
  // ---------------------------------------------------------------------------
  describe('resetTimer', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('resets isRunning, elapsedTime, and currentStatus to defaults', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      act(() => {
        result.current.resetTimer();
      });

      expect(result.current.isRunning).toBe(false);
      expect(result.current.elapsedTime).toBe(0);
      expect(result.current.currentStatus).toBe('blue');
    });
  });

  // ---------------------------------------------------------------------------
  // Status transitions
  // ---------------------------------------------------------------------------
  describe('status transitions', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('transitions blue -> green -> yellow -> red at the correct thresholds', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      // Advance to just past green threshold (30s)
      act(() => {
        vi.advanceTimersByTime(30100);
      });
      expect(result.current.currentStatus).toBe('green');

      // Advance to just past yellow threshold (45s total)
      act(() => {
        vi.advanceTimersByTime(15000);
      });
      expect(result.current.currentStatus).toBe('yellow');

      // Advance to just past red threshold (60s total)
      act(() => {
        vi.advanceTimersByTime(15000);
      });
      expect(result.current.currentStatus).toBe('red');
    });
  });

  // ---------------------------------------------------------------------------
  // updateSpeakerName
  // ---------------------------------------------------------------------------
  describe('updateSpeakerName', () => {
    it('updates only the name of the current speaker', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.updateSpeakerName('Bob');
      });

      expect(result.current.currentSpeaker.name).toBe('Bob');
      expect(result.current.currentSpeaker.role).toBe(SHORT_ROLES_SPEAKER.role);
      expect(result.current.currentSpeaker.rules).toEqual(SHORT_ROLES_SPEAKER.rules);
    });
  });

  // ---------------------------------------------------------------------------
  // Agenda CRUD
  // ---------------------------------------------------------------------------
  describe('agenda CRUD', () => {
    it('adds a speaker to the agenda with correct shape', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.addToAgenda({ name: 'Alice', role: 'Standard Speech' });
      });

      expect(result.current.agenda).toHaveLength(1);
      const item = result.current.agenda[0];
      expect(item.name).toBe('Alice');
      expect(item.role).toBe('Standard Speech');
      expect(item.rules).toBeDefined();
      expect(item.completed).toBe(false);
    });

    it('removes a speaker from the agenda by id', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      let itemId;
      act(() => {
        itemId = result.current.addToAgenda({ name: 'Alice', role: 'Standard Speech' });
      });

      act(() => {
        result.current.removeFromAgenda(itemId);
      });

      expect(result.current.agenda).toHaveLength(0);
    });

    it('marks an item as completed', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      let itemId;
      act(() => {
        itemId = result.current.addToAgenda({ name: 'Alice', role: 'Standard Speech' });
      });

      act(() => {
        result.current.markCompleted(itemId);
      });

      expect(result.current.agenda[0].completed).toBe(true);
    });

    it('clears all agenda items', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.addToAgenda({ name: 'Alice', role: 'Standard Speech' });
        result.current.addToAgenda({ name: 'Bob', role: 'Ice Breaker' });
      });

      act(() => {
        result.current.clearAllAgenda();
      });

      expect(result.current.agenda).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // importBulkSpeakers
  // ---------------------------------------------------------------------------
  describe('importBulkSpeakers', () => {
    it('imports speakers from newline-separated text and returns count', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      let count;
      act(() => {
        count = result.current.importBulkSpeakers('Alice\nBob');
      });

      expect(count).toBe(2);
      expect(result.current.agenda).toHaveLength(2);
    });

    it('imports "Person (A)" as custom role A with its rules', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });
      const aRules = { green: 10, yellow: 20, red: 30, graceAfterRed: 10 };

      act(() => {
        result.current.addRoleRules('A', aRules);
      });
      act(() => {
        result.current.importBulkSpeakers('Person (A)');
      });

      expect(result.current.agenda).toHaveLength(1);
      expect(result.current.agenda[0]).toMatchObject({ name: 'Person', role: 'A', rules: aRules });
    });

    it('imports a custom role whose rules were saved without a role order', () => {
      // Legacy saved rules and club presets published without `order` leave a
      // role in roleRules (and the dropdown) but out of customRoleOrder.
      const openerRules = { green: 60, yellow: 90, red: 120, graceAfterRed: 15 };
      localStorage.setItem('toastmaster_role_rules', JSON.stringify({ Opener: openerRules }));
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      expect(result.current.roleOptions).toContain('Opener');
      act(() => {
        result.current.importBulkSpeakers('Ana (Opener)');
      });

      expect(result.current.agenda[0]).toMatchObject({ name: 'Ana', role: 'Opener', rules: openerRules });
    });

    it('reports how many imported lines got a custom role', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.addRoleRules('A', { green: 10, yellow: 20, red: 30, graceAfterRed: 10 });
      });
      act(() => {
        result.current.importBulkSpeakers('Person (A)\nBob (Ice Breaker)');
      });

      expect(trackEvent).toHaveBeenCalledWith('agenda_imported', {
        import_type: 'bulk',
        items_count: 2,
        custom_role_count: 1,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // finishCurrentSpeech / reports
  // ---------------------------------------------------------------------------
  describe('finishCurrentSpeech', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('adds a report with color green when finishing in the green zone (35s)', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      // Advance to 35s (inside green zone: 30-45s)
      act(() => {
        vi.advanceTimersByTime(35000);
      });

      act(() => {
        result.current.finishCurrentSpeech();
      });

      expect(result.current.reports).toHaveLength(1);
      expect(result.current.reports[0].color).toBe('green');
      expect(result.current.reports[0].disqualified).toBe(false);
    });

    it('adds a report with "Passed red" comment when finishing past the red threshold', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      // Advance to 65s (past red at 60s, but within grace of 15s so not disqualified)
      act(() => {
        vi.advanceTimersByTime(65000);
      });

      act(() => {
        result.current.finishCurrentSpeech();
      });

      expect(result.current.reports).toHaveLength(1);
      expect(result.current.reports[0].comments).toMatch(/Passed red/i);
      expect(result.current.reports[0].disqualified).toBe(false);
    });

    it('adds a report with "before green" comment when finishing before green threshold', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      // Advance to 20s (before green at 30s)
      act(() => {
        vi.advanceTimersByTime(20000);
      });

      act(() => {
        result.current.finishCurrentSpeech();
      });

      expect(result.current.reports).toHaveLength(1);
      expect(result.current.reports[0].comments).toMatch(/before green/i);
    });

    it('marks report as disqualified when finishing past red + grace (76s)', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.setCurrentSpeaker(SHORT_ROLES_SPEAKER);
      });

      act(() => {
        result.current.startTimer();
      });

      // Advance to 76s (past red:60 + grace:15 = 75s)
      act(() => {
        vi.advanceTimersByTime(76000);
      });

      act(() => {
        result.current.finishCurrentSpeech();
      });

      expect(result.current.reports).toHaveLength(1);
      expect(result.current.reports[0].disqualified).toBe(true);
      expect(result.current.reports[0].comments).toMatch(/\(Disqualified\)/);
    });
  });

  // ---------------------------------------------------------------------------
  // Role rules
  // ---------------------------------------------------------------------------
  describe('role rules', () => {
    it('adds a custom role rule', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.addRoleRules('My Custom', { green: 10, yellow: 20, red: 30, graceAfterRed: 10 });
      });

      expect(result.current.roleRules['My Custom']).toEqual({
        green: 10,
        yellow: 20,
        red: 30,
        graceAfterRed: 10,
      });
    });

    it('updates an existing role rule', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.addRoleRules('My Custom', { green: 10, yellow: 20, red: 30, graceAfterRed: 10 });
      });

      act(() => {
        result.current.updateRoleRules('My Custom', { green: 15, yellow: 25, red: 35, graceAfterRed: 10 });
      });

      expect(result.current.roleRules['My Custom']).toEqual({
        green: 15,
        yellow: 25,
        red: 35,
        graceAfterRed: 10,
      });
    });

    it('removes a builtin role by hiding it (disappears from roleOptions)', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      // Verify Short Roles is visible initially
      expect(result.current.roleOptions).toContain('Short Roles');

      act(() => {
        result.current.removeRoleRules('Short Roles');
      });

      expect(result.current.roleOptions).not.toContain('Short Roles');
    });

    it('removes a custom role entirely from roleRules', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      act(() => {
        result.current.addRoleRules('My Custom', { green: 10, yellow: 20, red: 30, graceAfterRed: 10 });
      });

      act(() => {
        result.current.removeRoleRules('My Custom');
      });

      expect(result.current.roleRules['My Custom']).toBeUndefined();
    });

    it('restores all builtin roles after resetAllRoleRulesToDefaults', () => {
      const { result } = renderHook(() => useAllTimer(), { wrapper });

      // Hide a builtin role first
      act(() => {
        result.current.removeRoleRules('Short Roles');
      });

      expect(result.current.roleOptions).not.toContain('Short Roles');

      act(() => {
        result.current.resetAllRoleRulesToDefaults();
      });

      expect(result.current.roleOptions).toContain('Short Roles');
    });
  });
});
