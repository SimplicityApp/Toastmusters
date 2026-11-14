import { parseSimpleFormatText, findRoleByName, agendaItemNeedsRole } from '../simpleFormatParser.js';
import { ROLE_OPTIONS, BREAK_ROLE } from '../timingRules.js';

// The dropdown a user with every built-in visible and two custom roles sees.
const ROLES = [...ROLE_OPTIONS, 'Keynote Speaker', 'Table Topics Master'];

describe('parseSimpleFormatText: exact role names (#91 AC-1)', () => {
  it('imports "Person (A)" as Person with role A', () => {
    expect(parseSimpleFormatText('Person (A)', ['A'])).toEqual([
      { name: 'Person', role: 'A', roleText: 'A' },
    ]);
  });

  it('ignores case, spacing and punctuation, and returns the listed spelling', () => {
    const [item] = parseSimpleFormatText('Cam-Ly ( opening   REMARKS )', ['Opening Remarks']);
    expect(item).toEqual({ name: 'Cam-Ly', role: 'Opening Remarks', roleText: 'opening   REMARKS' });
    expect(parseSimpleFormatText('B (keynote speaker)', ROLES)[0].role).toBe('Keynote Speaker');
    expect(parseSimpleFormatText('Q (q & a)', ['Q&A'])[0].role).toBe('Q&A');
  });

  it('matches built-in roles that are in the list', () => {
    expect(parseSimpleFormatText('David Kim (Table Topics Speech)', ROLES)[0]).toEqual({
      name: 'David Kim',
      role: 'Table Topics Speech',
      roleText: 'Table Topics Speech',
    });
  });

  it('reads the role from the last bracket group', () => {
    expect(parseSimpleFormatText('Cam-Ly (VPE) (A)', ['A'])[0]).toEqual({
      name: 'Cam-Ly',
      role: 'A',
      roleText: 'A',
    });
  });

  it('parses each line on its own and skips blank lines', () => {
    const result = parseSimpleFormatText('Person (A)\nBob (Ice Breaker)\n\n  Carol (B)  ', ['A', 'B', 'Ice Breaker']);
    expect(result.map(({ name, role }) => [name, role])).toEqual([
      ['Person', 'A'],
      ['Bob', 'Ice Breaker'],
      ['Carol', 'B'],
    ]);
  });

  it('gives every demo-agenda-simple.txt line its role', () => {
    const lines = [
      ['Sarah Chen', 'Ice Breaker'],
      ['James Wilson', 'Standard Speech'],
      ['David Kim', 'Table Topics Speech'],
      ['Emily Brown', 'Speech Evaluation'],
      ['Michael Lee', 'General Evaluation'],
    ];
    const text = lines.map(([name, role]) => `${name} (${role})`).join('\n');
    expect(parseSimpleFormatText(text, ROLE_OPTIONS).map(({ name, role }) => [name, role])).toEqual(lines);
  });
});

describe('parseSimpleFormatText: no guessing (#91 AC-2, AC-3)', () => {
  it.each([
    ['Alex (Table Topics)', 'Table Topics'], // was Table Topics, then Table Topics Master
    ['C (Keynote)', 'Keynote'], // was the closest custom role
    ['D (Speaker)', 'Speaker'], // was the closest custom role
    ['Lee (Moment of Reflection)', 'Moment of Reflection'], // was a Short Roles keyword
    ['G (Toastmaster of the Evening)', 'Toastmaster of the Evening'],
    ['Yu (Closing Remarks - 2 min)', 'Closing Remarks - 2 min'], // a role plus extra words
    ['H (Educational Talk)', 'Educational Talk'], // was the Standard Speech default
  ])('%s needs a role; its text is kept as written', (line, roleText) => {
    const [item] = parseSimpleFormatText(line, [...ROLES, 'Closing Remarks']);
    expect(item.role).toBeNull();
    expect(item.roleText).toBe(roleText);
  });

  it('does not match a role the user removed or hid', () => {
    const withoutIceBreaker = ROLES.filter((role) => role !== 'Ice Breaker');
    expect(parseSimpleFormatText('I (Ice Breaker)', withoutIceBreaker)[0]).toEqual({
      name: 'I',
      role: null,
      roleText: 'Ice Breaker',
    });
  });

  it('matches nothing when no roles are passed', () => {
    expect(parseSimpleFormatText('Person (Standard Speech)', [])[0].role).toBeNull();
    expect(parseSimpleFormatText('Person (Standard Speech)')[0].role).toBeNull();
    expect(parseSimpleFormatText('Person (Standard Speech)', null)[0].role).toBeNull();
  });

  it('never takes a role from a keyword in the name (#90)', () => {
    expect(parseSimpleFormatText('Dominique - General Evaluation (Table Topics)', ROLES)[0]).toEqual({
      name: 'Dominique - General Evaluation',
      role: null,
      roleText: 'Table Topics',
    });
    expect(parseSimpleFormatText('Tim Timer (Standard Speech)', ROLES)[0].role).toBe('Standard Speech');
  });

  it('treats empty brackets as no role', () => {
    expect(parseSimpleFormatText('Sarah ()', ROLES)[0]).toEqual({ name: 'Sarah', role: null, roleText: '' });
    expect(parseSimpleFormatText('Sarah (   )', ROLES)[0]).toEqual({ name: 'Sarah', role: null, roleText: '' });
  });
});

describe('parseSimpleFormatText: lines with no brackets', () => {
  it('gives a line that names a role that role, and keeps it as the name', () => {
    expect(parseSimpleFormatText('A', ['A'])).toEqual([{ name: 'A', role: 'A', roleText: 'A' }]);
    expect(parseSimpleFormatText('take a break', [BREAK_ROLE])[0].role).toBe(BREAK_ROLE);
  });

  it('gives any other line no role and an empty roleText', () => {
    expect(parseSimpleFormatText('Alice', ROLES)).toEqual([{ name: 'Alice', role: null, roleText: '' }]);
    expect(parseSimpleFormatText('Coffee break', [...ROLES, BREAK_ROLE])[0]).toEqual({
      name: 'Coffee break',
      role: null,
      roleText: '',
    });
  });
});

describe('parseSimpleFormatText: speaker names', () => {
  it('names a bracket-only line "Speaker N"', () => {
    expect(parseSimpleFormatText('(Ice Breaker)', ROLES)).toEqual([
      { name: 'Speaker 1', role: 'Ice Breaker', roleText: 'Ice Breaker' },
    ]);
  });

  it('counts "Speaker N" by non-blank line', () => {
    expect(parseSimpleFormatText('Alice\n\n(Ice Breaker)', ROLES)[1].name).toBe('Speaker 2');
  });

  it('removes every bracket group from the name', () => {
    expect(parseSimpleFormatText('Cam-Ly (VPE) - Opening (Opening)', ['Opening'])[0].name).toBe('Cam-Ly  - Opening');
  });

  it('returns an empty list for blank text', () => {
    expect(parseSimpleFormatText('')).toEqual([]);
    expect(parseSimpleFormatText('  \n \n')).toEqual([]);
    expect(parseSimpleFormatText(undefined)).toEqual([]);
  });
});

describe('findRoleByName', () => {
  it('needs the same words in the same order', () => {
    expect(findRoleByName('Opening Remarks', ['Opening Remarks'])).toBe('Opening Remarks');
    expect(findRoleByName('Remarks Opening', ['Opening Remarks'])).toBeNull();
    expect(findRoleByName('Opening', ['Opening Remarks'])).toBeNull();
    expect(findRoleByName('Opening Remarks - 2 min', ['Opening Remarks'])).toBeNull();
  });

  it('treats punctuation as a word break', () => {
    expect(findRoleByName('Table-Topics Speech', ['Table Topics Speech'])).toBe('Table Topics Speech');
    expect(findRoleByName('Q and A', ['Q&A'])).toBeNull();
  });

  it('returns the first match in list order', () => {
    expect(findRoleByName('opening', ['Opening', 'OPENING'])).toBe('Opening');
  });

  it('returns null for empty text or no list, and skips empty names', () => {
    expect(findRoleByName('', ['A'])).toBeNull();
    expect(findRoleByName(' - ', ['A'])).toBeNull();
    expect(findRoleByName('A', [])).toBeNull();
    expect(findRoleByName('A', undefined)).toBeNull();
    expect(findRoleByName('A', ['', null, '!!!', 'A'])).toBe('A');
  });
});

describe('agendaItemNeedsRole', () => {
  it('is false for a row whose role is listed', () => {
    expect(agendaItemNeedsRole({ role: 'Keynote Speaker' }, ROLES)).toBe(false);
    expect(agendaItemNeedsRole({ role: 'Custom' }, ROLES)).toBe(false);
  });

  it('is true for an unmatched import, a row with no role, and an old Table Topics row', () => {
    expect(agendaItemNeedsRole({ role: 'Educational Talk' }, ROLES)).toBe(true);
    expect(agendaItemNeedsRole({ role: '' }, ROLES)).toBe(true);
    expect(agendaItemNeedsRole({ role: 'Table Topics' }, ROLES)).toBe(true);
  });

  it('is true for a role that left the list', () => {
    const withoutIceBreaker = ROLES.filter((role) => role !== 'Ice Breaker');
    expect(agendaItemNeedsRole({ role: 'Ice Breaker' }, withoutIceBreaker)).toBe(true);
  });

  it('never flags a completed row or a break', () => {
    expect(agendaItemNeedsRole({ role: 'Educational Talk', completed: true }, ROLES)).toBe(false);
    expect(agendaItemNeedsRole({ role: BREAK_ROLE }, ROLES)).toBe(false);
  });

  it('is false for no item', () => {
    expect(agendaItemNeedsRole(null, ROLES)).toBe(false);
  });
});
