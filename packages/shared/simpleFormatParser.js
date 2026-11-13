import { BREAK_ROLE } from './timingRules.js';

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
 * Returns the role in `roleNames` that `text` names, or null.
 *
 * A name matches when it has the same words in the same order; case, spacing
 * and punctuation are ignored. Nothing looser: a near miss is the user's to
 * resolve, not ours to guess (#91). The first match in list order wins.
 */
export function findRoleByName(text, roleNames) {
  const words = roleWords(text);
  if (words.length === 0 || !Array.isArray(roleNames)) return null;
  return roleNames.find((name) => name && sameWords(roleWords(name), words)) ?? null;
}

/**
 * Parses Simple Format agenda text ("Name (Role)", one per line).
 *
 * Returns `{ name, role, roleText }` per non-blank line:
 * - name: the line with every "(...)" removed, or "Speaker N".
 * - roleText: the role as written. The last "(...)" group; for a line with no
 *   brackets, the whole line when it names a role, otherwise ''.
 * - role: the entry of `roleNames` that roleText names (see findRoleByName),
 *   or null. Callers pass the roles the user can pick, so a hidden built-in or
 *   a deleted custom role is never matched.
 */
export function parseSimpleFormatText(text, roleNames = []) {
  const names = Array.isArray(roleNames) ? roleNames : [];
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    const name = line.replace(BRACKET_GROUP, '').trim() || `Speaker ${index + 1}`;
    const groups = [...line.matchAll(BRACKET_GROUP)];
    if (groups.length > 0) {
      const roleText = groups[groups.length - 1][1].trim();
      return { name, role: findRoleByName(roleText, names), roleText };
    }
    const role = findRoleByName(line, names);
    return { name, role, roleText: role ? line : '' };
  });
}

/**
 * Whether an agenda row has to have its role picked before it can be timed:
 * its role is not one the user can pick (an import that matched nothing, a row
 * saved before #91 as 'Table Topics', or a role removed since). Completed rows
 * are history, and a break carries its own rules, so neither is flagged.
 */
export function agendaItemNeedsRole(item, roleNames) {
  if (!item || item.completed || item.role === BREAK_ROLE) return false;
  return !(Array.isArray(roleNames) && roleNames.includes(item.role));
}
