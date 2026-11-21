import { createContext, useContext } from 'react';

/**
 * Which panel a shared component is drawn in: 'classic' (today's) or 'b'
 * (design B, plan 13). Dialogs that both panels open (Upgrade, the club
 * question, the Pro launch) read it to present themselves the new way inside
 * design B's shell, and stay exactly as they are everywhere else.
 */
export const LookContext = createContext('classic');

export function useLook() {
  return useContext(LookContext);
}
