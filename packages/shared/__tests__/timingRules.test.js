import {
  DEFAULT_ROLE_RULES,
  ROLE_OPTIONS,
  DEFAULT_CUSTOM_RULES,
  getDefaultGraceAfterRed,
  detectRoleFromText,
  deriveBreakRules,
  BREAK_ROLE,
} from '../timingRules.js';

describe('DEFAULT_ROLE_RULES', () => {
  it('contains exactly 8 roles', () => {
    expect(Object.keys(DEFAULT_ROLE_RULES)).toHaveLength(8);
  });

  it('contains all expected role names', () => {
    const expectedRoles = [
      'Short Roles',
      'Table Topics Speech',
      'Table Topics Evaluation',
      'Standard Speech',
      'Ice Breaker',
      'Speech Evaluation',
      'General Evaluation',
      'Custom',
    ];
    expectedRoles.forEach(role => {
      expect(DEFAULT_ROLE_RULES).toHaveProperty(role);
    });
  });

  it('has green < yellow < red for every role', () => {
    Object.entries(DEFAULT_ROLE_RULES).forEach(([role, rules]) => {
      expect(rules.green).toBeLessThan(rules.yellow);
      expect(rules.yellow).toBeLessThan(rules.red);
    });
  });

  it('has a numeric graceAfterRed for every role', () => {
    Object.entries(DEFAULT_ROLE_RULES).forEach(([role, rules]) => {
      expect(typeof rules.graceAfterRed).toBe('number');
    });
  });

  it('has correct values for Standard Speech', () => {
    expect(DEFAULT_ROLE_RULES['Standard Speech']).toEqual({
      green: 300,
      yellow: 360,
      red: 420,
      graceAfterRed: 30,
    });
  });

  it('has correct values for Short Roles', () => {
    expect(DEFAULT_ROLE_RULES['Short Roles']).toEqual({
      green: 30,
      yellow: 45,
      red: 60,
      graceAfterRed: 15,
    });
  });

  it('has correct values for Table Topics Evaluation', () => {
    expect(DEFAULT_ROLE_RULES['Table Topics Evaluation']).toEqual({
      green: 30,
      yellow: 45,
      red: 60,
      graceAfterRed: 15,
    });
  });
});

describe('ROLE_OPTIONS', () => {
  it('has exactly 8 entries', () => {
    expect(ROLE_OPTIONS).toHaveLength(8);
  });

  it('matches the keys of DEFAULT_ROLE_RULES', () => {
    expect(ROLE_OPTIONS).toEqual(Object.keys(DEFAULT_ROLE_RULES));
  });
});

describe('DEFAULT_CUSTOM_RULES', () => {
  it('is a shallow clone of the Custom role rules', () => {
    expect(DEFAULT_CUSTOM_RULES).toEqual(DEFAULT_ROLE_RULES['Custom']);
  });

  it('is not the same object reference as DEFAULT_ROLE_RULES["Custom"]', () => {
    expect(DEFAULT_CUSTOM_RULES).not.toBe(DEFAULT_ROLE_RULES['Custom']);
  });
});

describe('getDefaultGraceAfterRed', () => {
  it('returns 15 for Short Roles', () => {
    expect(getDefaultGraceAfterRed('Short Roles')).toBe(15);
  });

  it('returns 15 for Table Topics Evaluation', () => {
    expect(getDefaultGraceAfterRed('Table Topics Evaluation')).toBe(15);
  });

  it('returns 30 for Standard Speech', () => {
    expect(getDefaultGraceAfterRed('Standard Speech')).toBe(30);
  });

  it('returns 30 for Ice Breaker', () => {
    expect(getDefaultGraceAfterRed('Ice Breaker')).toBe(30);
  });

  it('returns 30 for Speech Evaluation', () => {
    expect(getDefaultGraceAfterRed('Speech Evaluation')).toBe(30);
  });

  it('returns 30 for General Evaluation', () => {
    expect(getDefaultGraceAfterRed('General Evaluation')).toBe(30);
  });

  it('returns 30 for Table Topics Speech', () => {
    expect(getDefaultGraceAfterRed('Table Topics Speech')).toBe(30);
  });
});

describe('detectRoleFromText', () => {
  describe('fallback parameter', () => {
    it('returns null instead of Standard Speech when fallback is null and nothing matches', () => {
      expect(detectRoleFromText('Pathways L2', null, null)).toBeNull();
    });

    it('still returns a matched role when fallback is null', () => {
      expect(detectRoleFromText('Table Topics', null, null)).toBe('Table Topics');
    });
  });

  describe('exact case-insensitive matches', () => {
    it('maps "standard speech" to Standard Speech', () => {
      expect(detectRoleFromText('standard speech')).toBe('Standard Speech');
    });

    it('maps "ICE BREAKER" to Ice Breaker', () => {
      expect(detectRoleFromText('ICE BREAKER')).toBe('Ice Breaker');
    });

    it('maps "table topics evaluation" to Table Topics Evaluation', () => {
      expect(detectRoleFromText('table topics evaluation')).toBe('Table Topics Evaluation');
    });

    it('maps "speech evaluation" to Speech Evaluation', () => {
      expect(detectRoleFromText('speech evaluation')).toBe('Speech Evaluation');
    });

    it('maps "general evaluation" to General Evaluation', () => {
      expect(detectRoleFromText('general evaluation')).toBe('General Evaluation');
    });

    it('maps "short roles" to Short Roles', () => {
      expect(detectRoleFromText('short roles')).toBe('Short Roles');
    });
  });

  describe('partial matches for numbered speaker roles', () => {
    it('maps "1st speaker" to Standard Speech', () => {
      expect(detectRoleFromText('1st speaker')).toBe('Standard Speech');
    });

    it('maps "2nd speaker Ice Breaker" to Ice Breaker', () => {
      expect(detectRoleFromText('2nd speaker Ice Breaker')).toBe('Ice Breaker');
    });

    it('maps "3rd Speaker" to Standard Speech', () => {
      expect(detectRoleFromText('3rd Speaker')).toBe('Standard Speech');
    });
  });

  describe('partial matches for evaluator roles', () => {
    it('maps "general evaluator" to General Evaluation', () => {
      expect(detectRoleFromText('general evaluator')).toBe('General Evaluation');
    });

    it('maps "1st evaluator" to Speech Evaluation', () => {
      expect(detectRoleFromText('1st evaluator')).toBe('Speech Evaluation');
    });

    it('maps "2nd evaluator" to Speech Evaluation', () => {
      expect(detectRoleFromText('2nd evaluator')).toBe('Speech Evaluation');
    });
  });

  describe('short roles detection', () => {
    it('maps "timer" to Short Roles', () => {
      expect(detectRoleFromText('timer')).toBe('Short Roles');
    });

    it('maps "grammarian" to Short Roles', () => {
      expect(detectRoleFromText('grammarian')).toBe('Short Roles');
    });

    it('maps "ah counter" to Short Roles', () => {
      expect(detectRoleFromText('ah counter')).toBe('Short Roles');
    });

    it('maps "toastmaster" to Short Roles', () => {
      expect(detectRoleFromText('toastmaster')).toBe('Short Roles');
    });

    it('maps "sergeant at arms" to Short Roles', () => {
      expect(detectRoleFromText('sergeant at arms')).toBe('Short Roles');
    });

    // "table topics master" hits the "table topics" partial-match branch in the
    // source before reaching the short-roles branch, so it returns 'Table Topics'.
    // The isEasySpeakFormat and parseEasySpeakText functions handle the correct
    // exclusion/mapping of Table Topics Master at a higher level.
    it('maps "table topics master" to Table Topics (source partial-match order)', () => {
      expect(detectRoleFromText('table topics master')).toBe('Table Topics');
    });
  });

  describe('custom role names', () => {
    it('matches a custom role name with case-insensitive exact match', () => {
      expect(detectRoleFromText('my role', ['My Role'])).toBe('My Role');
    });

    it('returns the custom role with original casing', () => {
      expect(detectRoleFromText('my custom role', ['My Custom Role'])).toBe('My Custom Role');
    });

    it('does not match a custom role on partial text', () => {
      // 'my role xyz' does not exactly match 'My Role'
      expect(detectRoleFromText('my role xyz', ['My Role'])).not.toBe('My Role');
    });
  });

  describe('unknown / unrecognised text', () => {
    it('falls back to Standard Speech for unknown text', () => {
      expect(detectRoleFromText('unknown random text xyz')).toBe('Standard Speech');
    });
  });
});

describe('deriveBreakRules', () => {
  it('splits the total 60/80/100, so every break has the same rhythm', () => {
    expect(deriveBreakRules(600)).toMatchObject({ green: 360, yellow: 480, red: 600 });
    expect(deriveBreakRules(300)).toMatchObject({ green: 180, yellow: 240, red: 300 });
    expect(deriveBreakRules(180)).toMatchObject({ green: 108, yellow: 144, red: 180 });
  });

  it('marks the rules as a countdown with no disqualification grace', () => {
    expect(deriveBreakRules(600)).toMatchObject({ countdown: true, graceAfterRed: 0 });
  });

  it('clamps absurd lengths to something a timer can run', () => {
    // A half-typed custom value must not produce a zero-length break.
    expect(deriveBreakRules(0).red).toBe(30);
    expect(deriveBreakRules(undefined).red).toBe(30);
  });
});

describe('detectRoleFromText: breaks', () => {

  it.each(['Break', 'break', 'Coffee Break', '10 min break', 'Break time'])(
    'detects %s as a break',
    (text) => {
      expect(detectRoleFromText(text)).toBe(BREAK_ROLE);
    }
  );

  it('still detects Ice Breaker as Ice Breaker, not a break', () => {
    expect(detectRoleFromText('Ice Breaker')).toBe('Ice Breaker');
    expect(detectRoleFromText('Icebreaker #1')).toBe('Ice Breaker');
  });
});
