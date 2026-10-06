import { detectRoleFromText } from './timingRules.js';

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

/**
 * Returns the custom role named by the bracket text, or null.
 * The first custom role whose words equal the bracket's words wins.
 */
export function matchCustomRole(bracketText, customRoleNames) {
  const bracket = roleWords(bracketText);
  if (bracket.length === 0 || !Array.isArray(customRoleNames)) return null;

  for (const name of customRoleNames) {
    if (!name) continue;
    const words = roleWords(name);
    if (words.length > 0 && sameWords(words, bracket)) return name;
  }
  return null;
}

/**
 * Parses Simple Format agenda text ("Name (Role)", one per line).
 * The name is the line with every "(...)" removed, or "Speaker N".
 * The role is the custom role named in the last "(...)" group, otherwise
 * today's whole-line detection.
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
