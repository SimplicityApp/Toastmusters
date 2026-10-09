import {
  saveAgenda,
  loadAgenda,
  clearAgenda,
  saveReports,
  loadReports,
  clearReports,
  saveRoleRules,
  loadRoleRules,
  saveRoleOrder,
  loadRoleOrder,
  saveHiddenBuiltinRoles,
  loadHiddenBuiltinRoles,
  saveOverlayMode,
  loadOverlayMode,
  saveTimeInputMode,
  loadTimeInputMode,
  saveTimerSession,
  loadTimerSession,
  clearTimerSession,
  clearAllStorage,
} from '../storage.js';

// The vitest jsdom environment provides localStorage globally.
// We clear it before each test to guarantee isolation.
beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------
describe('Agenda storage', () => {
  it('saves and loads agenda items', () => {
    const items = [
      { name: 'Alice', role: 'Standard Speech' },
      { name: 'Bob', role: 'Table Topics Speech' },
    ];
    saveAgenda(items);
    expect(loadAgenda()).toEqual(items);
  });

  it('returns an empty array when nothing has been saved', () => {
    expect(loadAgenda()).toEqual([]);
  });

  it('returns an empty array after clearAgenda', () => {
    saveAgenda([{ name: 'Alice', role: 'Standard Speech' }]);
    clearAgenda();
    expect(loadAgenda()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
describe('Reports storage', () => {
  it('saves and loads reports', () => {
    const reports = [{ id: 1, speaker: 'Alice', elapsed: 320 }];
    saveReports(reports);
    expect(loadReports()).toEqual(reports);
  });

  it('returns an empty array when nothing has been saved', () => {
    expect(loadReports()).toEqual([]);
  });

  it('returns an empty array after clearReports', () => {
    saveReports([{ id: 1 }]);
    clearReports();
    expect(loadReports()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Role rules
// ---------------------------------------------------------------------------
describe('Role rules storage', () => {
  it('saves and loads a role rules object', () => {
    const rules = {
      'Standard Speech': { green: 300, yellow: 360, red: 420, graceAfterRed: 30 },
    };
    saveRoleRules(rules);
    expect(loadRoleRules()).toEqual(rules);
  });

  it('returns null when nothing has been saved', () => {
    expect(loadRoleRules()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Role order
// ---------------------------------------------------------------------------
describe('Role order storage', () => {
  it('saves and loads a role order array', () => {
    const order = ['My Custom Role', 'Another Role'];
    saveRoleOrder(order);
    expect(loadRoleOrder()).toEqual(order);
  });

  it('returns an empty array when nothing has been saved', () => {
    expect(loadRoleOrder()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hidden built-in roles
// ---------------------------------------------------------------------------
describe('Hidden built-in roles storage', () => {
  it('saves and loads hidden built-in roles', () => {
    const hidden = ['Short Roles', 'Custom'];
    saveHiddenBuiltinRoles(hidden);
    expect(loadHiddenBuiltinRoles()).toEqual(hidden);
  });

  it('returns an empty array when nothing has been saved', () => {
    expect(loadHiddenBuiltinRoles()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Overlay mode
// ---------------------------------------------------------------------------
describe('Overlay mode storage', () => {
  it('saves and loads overlay mode', () => {
    saveOverlayMode('camera');
    expect(loadOverlayMode()).toBe('camera');
  });

  it('saves and loads "card" overlay mode', () => {
    saveOverlayMode('card');
    expect(loadOverlayMode()).toBe('card');
  });

  it('returns null when nothing has been saved', () => {
    expect(loadOverlayMode()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Time input mode
// ---------------------------------------------------------------------------
describe('Time input mode storage', () => {
  it('defaults to "minsec" when nothing has been saved', () => {
    expect(loadTimeInputMode()).toBe('minsec');
  });

  it('saves and loads "seconds" mode', () => {
    saveTimeInputMode('seconds');
    expect(loadTimeInputMode()).toBe('seconds');
  });

  it('saves and loads "minsec" mode explicitly', () => {
    saveTimeInputMode('minsec');
    expect(loadTimeInputMode()).toBe('minsec');
  });
});

// ---------------------------------------------------------------------------
// clearAllStorage
// ---------------------------------------------------------------------------
describe('clearAllStorage', () => {
  it('resets all storage values to their defaults', () => {
    // Populate every storage key.
    saveAgenda([{ name: 'Alice', role: 'Standard Speech' }]);
    saveReports([{ id: 1 }]);
    saveRoleRules({ 'Standard Speech': { green: 300, yellow: 360, red: 420, graceAfterRed: 30 } });
    saveRoleOrder(['My Role']);
    saveHiddenBuiltinRoles(['Custom']);
    saveOverlayMode('camera');
    saveTimeInputMode('seconds');

    clearAllStorage();

    expect(loadAgenda()).toEqual([]);
    expect(loadReports()).toEqual([]);
    expect(loadRoleRules()).toBeNull();
    expect(loadRoleOrder()).toEqual([]);
    expect(loadHiddenBuiltinRoles()).toEqual([]);
    expect(loadOverlayMode()).toBeNull();
    expect(loadTimeInputMode()).toBe('minsec');
  });
});

// ---------------------------------------------------------------------------
// Invalid JSON resilience
// ---------------------------------------------------------------------------
describe('Invalid JSON resilience', () => {
  it('loadAgenda returns [] when stored value is invalid JSON', () => {
    localStorage.setItem('toastmaster_agenda', '{invalid json}');
    expect(loadAgenda()).toEqual([]);
  });

  it('loadReports returns [] when stored value is invalid JSON', () => {
    localStorage.setItem('toastmaster_reports', 'not-json');
    expect(loadReports()).toEqual([]);
  });

  it('loadRoleRules returns null when stored value is invalid JSON', () => {
    localStorage.setItem('toastmaster_role_rules', '[[broken');
    expect(loadRoleRules()).toBeNull();
  });

  it('loadRoleOrder returns [] when stored value is invalid JSON', () => {
    localStorage.setItem('toastmaster_role_order', 'bad');
    expect(loadRoleOrder()).toEqual([]);
  });

  it('loadHiddenBuiltinRoles returns [] when stored value is invalid JSON', () => {
    localStorage.setItem('toastmaster_hidden_builtin_roles', '!!');
    expect(loadHiddenBuiltinRoles()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Timer session
// ---------------------------------------------------------------------------
describe('Timer session storage', () => {
  const session = {
    speaker: { name: 'Alice', role: 'Standard Speech', rules: { green: 300, yellow: 360, red: 420 } },
    activeSpeakerId: 'a1',
    running: true,
    baseElapsed: 12.5,
    startedAt: 1_700_000_000_000,
    savedAt: 1_700_000_000_500,
  };

  it('round-trips a running session', () => {
    saveTimerSession(session);
    expect(loadTimerSession()).toEqual(session);
  });

  it('round-trips a paused session with no start timestamp', () => {
    saveTimerSession({ ...session, running: false, startedAt: null });
    expect(loadTimerSession()).toEqual({ ...session, running: false, startedAt: null });
  });

  it('returns null when nothing is saved', () => {
    expect(loadTimerSession()).toBeNull();
  });

  it('clears the session', () => {
    saveTimerSession(session);
    clearTimerSession();
    expect(loadTimerSession()).toBeNull();
  });

  it('is cleared by clearAllStorage', () => {
    saveTimerSession(session);
    clearAllStorage();
    expect(loadTimerSession()).toBeNull();
  });

  it('rejects records that cannot boot a sane timer', () => {
    const bad = [
      'not json',
      '[]',
      JSON.stringify({ ...session, speaker: null }),
      JSON.stringify({ ...session, speaker: { name: 'x' } }),
      JSON.stringify({ ...session, running: 'yes' }),
      JSON.stringify({ ...session, baseElapsed: -1 }),
      JSON.stringify({ ...session, baseElapsed: 'soon' }),
      JSON.stringify({ ...session, savedAt: undefined }),
      JSON.stringify({ ...session, running: true, startedAt: null }),
    ];
    for (const raw of bad) {
      localStorage.setItem('toastmaster_timer_session', raw);
      expect(loadTimerSession(), raw).toBeNull();
    }
  });

  it('normalizes a non-string agenda link to null', () => {
    saveTimerSession({ ...session, activeSpeakerId: 42 });
    expect(loadTimerSession().activeSpeakerId).toBeNull();
  });
});
