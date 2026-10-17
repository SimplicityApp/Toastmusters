import { DEFAULT_ROLE_RULES, detectRoleFromText } from './timingRules.js';

// Matches one "(...)" group. The same non-greedy pattern strips groups from the
// speaker name, so the name rule and the role group always agree.
const BRACKET_GROUP = /\((.*?)\)/g;

/**
 * Splits text into lowercase words. Anything that is not a letter or a digit
 * is a word break, so case, extra spaces and punctuation do not matter.
 */
function roleWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function sameWords(a, b) {
  return a.length === b.length && a.every((word, i) => word === b[i]);
}

// True when `needle` appears in `haystack` as a contiguous run of whole words.
function containsRun(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, i) => haystack[start + i] === word)) return true;
  }
  return false;
}

// Word lists of the built-in role names. A bracket that names one of these
// exactly is never taken by a partial custom match. 'Custom' is the free-form
// role, not a name anyone writes in brackets, so it is left out.
const BUILT_IN_ROLE_WORDS = Object.keys(DEFAULT_ROLE_RULES)
  .filter((role) => role !== 'Custom')
  .map(roleWords);

/**
 * Returns the custom role named by the bracket text, or null.
 *
 * 1. Exact: the first custom role whose words equal the bracket's words.
 * 2. Guard: a bracket that names a built-in role gets no partial match.
 * 3. Partial: custom roles whose words contain the bracket's words as a
 *    contiguous run, or whose words are a contiguous run inside the bracket.
 *    The role sharing the most words wins; ties go to the earliest in the list.
 */
export function matchCustomRole(bracketText, customRoleNames) {
  const bracket = roleWords(bracketText);
  if (bracket.length === 0 || !Array.isArray(customRoleNames)) return null;

  const candidates = customRoleNames
    .filter(Boolean)
    .map((name) => ({ name, words: roleWords(name) }))
    .filter(({ words }) => words.length > 0);

  const exact = candidates.find(({ words }) => sameWords(words, bracket));
  if (exact) return exact.name;

  if (BUILT_IN_ROLE_WORDS.some((words) => sameWords(words, bracket))) return null;

  let best = null;
  let bestScore = 0;
  for (const { name, words } of candidates) {
    if (!containsRun(words, bracket) && !containsRun(bracket, words)) continue;
    const score = Math.min(words.length, bracket.length);
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Parses Simple Format agenda text ("Name (Role)", one per line).
 * The name is the line with every "(...)" removed, or "Speaker N".
 * The role is the closest custom role to the last "(...)" group (see
 * matchCustomRole), otherwise today's whole-line detection.
 */
export function parseSimpleFormatText(text, customRoleNames = []) {
  const names = Array.isArray(customRoleNames) ? customRoleNames : [];
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    const name = line.replace(BRACKET_GROUP, '').trim() || `Speaker ${index + 1}`;
    const groups = [...line.matchAll(BRACKET_GROUP)];
    const bracket = groups.length > 0 ? groups[groups.length - 1][1] : '';
    const customRole = bracket ? matchCustomRole(bracket, names) : null;
    const role = customRole ?? detectRoleFromText(line, names);
    return { name, role };
  });
}
