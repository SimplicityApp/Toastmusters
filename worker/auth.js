import { verifySessionToken, readBearerToken } from './session-token.js';

/**
 * Who is calling, according to a token this Worker signed.
 *
 * One function for every authenticated route, so the rule "identity comes from
 * the signed token, never from the client" lives in exactly one place. Today
 * the token arrives as a bearer header (the Zoom app keeps it in
 * sessionStorage). Web sign-in will add a cookie transport here; callers will
 * not change.
 *
 * @param {Request} request
 * @param {Object} env - Worker env (SESSION_SIGNING_KEY)
 * @returns {{uid: string, exp: number}|null} null when nobody can be trusted
 */
export function readSession(request, env) {
  return verifySessionToken(readBearerToken(request), env.SESSION_SIGNING_KEY);
}
