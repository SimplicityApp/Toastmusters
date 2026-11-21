import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { resetFlagsForTests, setFlags } from '@toastmaster-timer/shared';
import { useNewLook, NEW_LOOK_LAST_KEY } from './useNewLook';

describe('useNewLook', () => {
  beforeEach(() => {
    resetFlagsForTests();
    localStorage.clear();
  });

  it('starts on today\'s panel on a device that has never had an answer', () => {
    const { result } = renderHook(() => useNewLook());
    expect(result.current).toBe(false);
  });

  it('follows the server once flags land, and remembers the answer', () => {
    const { result } = renderHook(() => useNewLook());
    act(() => {
      setFlags({ new_look: true });
    });
    expect(result.current).toBe(true);
    expect(localStorage.getItem(NEW_LOOK_LAST_KEY)).toBe('1');

    act(() => {
      setFlags({ new_look: false });
    });
    expect(result.current).toBe(false);
    expect(localStorage.getItem(NEW_LOOK_LAST_KEY)).toBe('0');
  });

  it('answers the remembered value while flags are unknown, so the new look does not flash the old one', () => {
    localStorage.setItem(NEW_LOOK_LAST_KEY, '1');
    const { result } = renderHook(() => useNewLook());
    expect(result.current).toBe(true);
  });

  it('lets the server overrule a remembered answer', () => {
    localStorage.setItem(NEW_LOOK_LAST_KEY, '1');
    const { result } = renderHook(() => useNewLook());
    act(() => {
      setFlags({});
    });
    expect(result.current).toBe(false);
  });
});
