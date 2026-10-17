import { parseSimpleFormatText, matchCustomRole } from '../simpleFormatParser.js';
import { detectRoleFromText } from '../timingRules.js';

describe('parseSimpleFormatText', () => {
  describe('custom role in brackets', () => {
    it('imports "Person (A)" as Person with custom role A', () => {
      expect(parseSimpleFormatText('Person (A)', ['A'])).toEqual([{ name: 'Person', role: 'A' }]);
    });

    it('ignores case and extra spaces inside the brackets', () => {
      const [item] = parseSimpleFormatText('Cam-Ly ( opening   REMARKS )', ['Opening Remarks']);
      expect(item).toEqual({ name: 'Cam-Ly', role: 'Opening Remarks' });
    });

    it('reads the role from the last bracket group', () => {
      const [item] = parseSimpleFormatText('Cam-Ly (VPE) (A)', ['A']);
      expect(item).toEqual({ name: 'Cam-Ly', role: 'A' });
    });

    it('returns the custom role with its original casing', () => {
      const [item] = parseSimpleFormatText('Ana (my role)', ['My Role']);
      expect(item.role).toBe('My Role');
    });

    it('parses each line independently', () => {
      const result = parseSimpleFormatText('Person (A)\nBob (Ice Breaker)\n\n  Carol (B)  ', ['A', 'B']);
      expect(result).toEqual([
        { name: 'Person', role: 'A' },
        { name: 'Bob', role: 'Ice Breaker' },
        { name: 'Carol', role: 'B' },
      ]);
    });
  });

  describe('fallback to detectRoleFromText', () => {
    it('keeps the bare custom role name working ("A" alone)', () => {
      expect(parseSimpleFormatText('A', ['A'])).toEqual([{ name: 'A', role: 'A' }]);
    });

    it('names a bracket-only line "Speaker N" and detects the built-in role', () => {
      expect(parseSimpleFormatText('(Ice Breaker)', [])).toEqual([
        { name: 'Speaker 1', role: 'Ice Breaker' },
      ]);
    });

    it('counts "Speaker N" by non-blank line index', () => {
      const result = parseSimpleFormatText('Alice\n\n(Ice Breaker)', []);
      expect(result[1]).toEqual({ name: 'Speaker 2', role: 'Ice Breaker' });
    });

    it('treats empty brackets as no role', () => {
      expect(parseSimpleFormatText('Sarah ()', ['A'])).toEqual([
        { name: 'Sarah', role: detectRoleFromText('Sarah ()', ['A']) },
      ]);
      expect(parseSimpleFormatText('Sarah (   )', ['A'])[0].role).toBe('Standard Speech');
    });

    it('uses today\'s detection when the bracket names no custom role', () => {
      const [item] = parseSimpleFormatText('Sarah (Ice Breaker)', ['A']);
      expect(item).toEqual({ name: 'Sarah', role: 'Ice Breaker' });
    });

    it('works with empty or missing customRoleNames', () => {
      expect(parseSimpleFormatText('Person (A)', [])).toEqual([{ name: 'Person', role: 'Standard Speech' }]);
      expect(parseSimpleFormatText('Person (A)')).toEqual([{ name: 'Person', role: 'Standard Speech' }]);
      expect(parseSimpleFormatText('Person (A)', null)).toEqual([{ name: 'Person', role: 'Standard Speech' }]);
    });

    it('returns an empty list for blank text', () => {
      expect(parseSimpleFormatText('')).toEqual([]);
      expect(parseSimpleFormatText('  \n \n')).toEqual([]);
    });

    it('gives demo-agenda-simple.txt lines today\'s built-in roles', () => {
      const lines = [
        'Sarah Chen (Ice Breaker)',
        'James Wilson (Standard Speech)',
        'Maria Garcia (Standard Speech)',
        'David Kim (Table Topics Speech)',
        'Lisa Zhang (Table Topics Speech)',
        'Ryan Patel (Table Topics Speech)',
        'Emily Brown (Speech Evaluation)',
        'Alex Thompson (Speech Evaluation)',
        'Michael Lee (General Evaluation)',
      ];
      const result = parseSimpleFormatText(lines.join('\n'), []);
      expect(result).toEqual([
        { name: 'Sarah Chen', role: 'Ice Breaker' },
        { name: 'James Wilson', role: 'Standard Speech' },
        { name: 'Maria Garcia', role: 'Standard Speech' },
        { name: 'David Kim', role: 'Table Topics' },
        { name: 'Lisa Zhang', role: 'Table Topics' },
        { name: 'Ryan Patel', role: 'Table Topics' },
        { name: 'Emily Brown', role: 'Speech Evaluation' },
        { name: 'Alex Thompson', role: 'Speech Evaluation' },
        { name: 'Michael Lee', role: 'General Evaluation' },
      ]);
      lines.forEach((line, i) => {
        expect(result[i].role).toBe(detectRoleFromText(line, []));
      });
    });
  });
});

describe('parseSimpleFormatText: PRD worked examples', () => {
  it.each([
    ['Person (A)', ['A'], 'Person', 'A'],
    ['Cam-Ly (opening remarks)', ['Opening Remarks'], 'Cam-Ly', 'Opening Remarks'],
    ['Cam-Ly (Opening)', ['Opening Remarks'], 'Cam-Ly', 'Opening Remarks'],
    ['Cam-Ly (Remarks)', ['Opening Remarks', 'Closing Remarks'], 'Cam-Ly', 'Opening Remarks'],
    ['Cam-Ly (Opening Remarks - 2 min)', ['Opening', 'Opening Remarks'], 'Cam-Ly', 'Opening Remarks'],
    ['Cam-Ly - Opening (Opening)', ['Opening'], 'Cam-Ly - Opening', 'Opening'],
    ['Dominique - General Evaluation (Closing)', ['Closing'], 'Dominique - General Evaluation', 'Closing'],
    ['Sarah (Ice Breaker)', ['Opening'], 'Sarah', 'Ice Breaker'],
  ])('%s with %j imports as %s / %s', (line, customRoles, name, role) => {
    expect(parseSimpleFormatText(line, customRoles)).toEqual([{ name, role }]);
  });
});

describe('matchCustomRole', () => {
  it('matches ignoring case, spacing and punctuation', () => {
    expect(matchCustomRole(' opening   REMARKS ', ['Opening Remarks'])).toBe('Opening Remarks');
    expect(matchCustomRole('Q & A', ['Q&A'])).toBe('Q&A');
  });

  it('returns the first exact match in list order', () => {
    expect(matchCustomRole('opening', ['Opening', 'OPENING'])).toBe('Opening');
  });

  it('prefers an exact match over a partial one listed earlier', () => {
    expect(matchCustomRole('Opening', ['Opening Remarks', 'Opening'])).toBe('Opening');
  });

  it('matches a shortened name inside a custom role', () => {
    expect(matchCustomRole('Opening', ['Opening Remarks'])).toBe('Opening Remarks');
    expect(matchCustomRole('remarks', ['Opening Remarks'])).toBe('Opening Remarks');
  });

  it('matches a custom role inside decorated bracket text', () => {
    expect(matchCustomRole('Opening Remarks - 2 min', ['Opening Remarks'])).toBe('Opening Remarks');
  });

  it('matches whole words only', () => {
    expect(matchCustomRole('Pen', ['Opening'])).toBeNull();
    expect(matchCustomRole('Open', ['Opening Remarks'])).toBeNull();
  });

  it('requires the shared words to be contiguous', () => {
    expect(matchCustomRole('Opening Closing', ['Opening Remarks Closing'])).toBeNull();
  });

  it('treats punctuation as word breaks', () => {
    expect(matchCustomRole('Q&A', ['Q&A Session'])).toBe('Q&A Session');
    expect(matchCustomRole('Q&A', ['Q and A'])).toBeNull();
    expect(matchCustomRole('Opening/Closing', ['Closing'])).toBe('Closing');
    expect(matchCustomRole('Opening/Closing', ['Opening Closing Remarks'])).toBe('Opening Closing Remarks');
  });

  it('picks the role sharing the most words', () => {
    expect(matchCustomRole('Opening Remarks - 2 min', ['Opening', 'Opening Remarks'])).toBe('Opening Remarks');
    expect(matchCustomRole('Opening Remarks - 2 min', ['Opening Remarks', 'Opening'])).toBe('Opening Remarks');
  });

  it('breaks ties by list order', () => {
    expect(matchCustomRole('Remarks', ['Opening Remarks', 'Closing Remarks'])).toBe('Opening Remarks');
    expect(matchCustomRole('Remarks', ['Closing Remarks', 'Opening Remarks'])).toBe('Closing Remarks');
  });

  it('never lets a partial match take a built-in role name', () => {
    expect(matchCustomRole('Standard Speech', ['Speech'])).toBeNull();
    expect(matchCustomRole('ice breaker', ['Ice'])).toBeNull();
    expect(parseSimpleFormatText('Ana (Standard Speech)', ['Speech'])).toEqual([
      { name: 'Ana', role: 'Standard Speech' },
    ]);
  });

  it('still lets an exact custom match take a built-in role name', () => {
    expect(matchCustomRole('Standard Speech', ['standard speech'])).toBe('standard speech');
    expect(matchCustomRole('Standard Speech', ['Speech', 'standard speech'])).toBe('standard speech');
  });

  it('does not guard "Custom", which is not a role name anyone writes', () => {
    expect(matchCustomRole('Custom', ['Custom Opening'])).toBe('Custom Opening');
  });

  it('returns null for empty bracket text or no candidates', () => {
    expect(matchCustomRole('', ['A'])).toBeNull();
    expect(matchCustomRole(' - ', ['A'])).toBeNull();
    expect(matchCustomRole('A', [])).toBeNull();
    expect(matchCustomRole('A', undefined)).toBeNull();
  });

  it('skips empty and punctuation-only custom names', () => {
    expect(matchCustomRole('A', ['', null, '!!!', 'A'])).toBe('A');
  });
});
