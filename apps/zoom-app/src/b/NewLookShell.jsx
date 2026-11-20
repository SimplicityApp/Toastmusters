import { ClassicShell } from '../App';

/**
 * Design B's panel: the top bar with the Agenda / Timer / Report switch, the
 * Pro chip and the ⋯ More menu, the timer card and the "Look & sound" sheets.
 *
 * Phase 0 of plan 13 only puts the `new_look` switch in place, so until the
 * Phase 1 shell lands this is today's panel unchanged. The flag is off
 * everywhere, so nobody sees the difference either way.
 */
export default function NewLookShell() {
  return <ClassicShell />;
}
