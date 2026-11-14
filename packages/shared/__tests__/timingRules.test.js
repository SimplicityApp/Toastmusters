import {
  DEFAULT_ROLE_RULES,
  ROLE_OPTIONS,
  DEFAULT_CUSTOM_RULES,
  getDefaultGraceAfterRed,
  deriveBreakRules,
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
