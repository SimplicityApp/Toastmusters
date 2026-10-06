import { describe, it, expect } from 'vitest'
import { signinFailureMessage, SIGNIN_ERRORS } from './signinFailure'

const params = (query) => new URLSearchParams(query)

describe('signinFailureMessage', () => {
  it('is null when the URL is not a failed sign-in', () => {
    expect(signinFailureMessage(params(''))).toBeNull()
    expect(signinFailureMessage(params('reason=denied'))).toBeNull()
    expect(signinFailureMessage(params('signin=ok&reason=denied'))).toBeNull()
    expect(signinFailureMessage(undefined)).toBeNull()
  })

  it('names the missing Zoom permission for reason=scope_not_granted', () => {
    const message = signinFailureMessage(params('signin=failed&reason=scope_not_granted'))
    expect(message).toBe(SIGNIN_ERRORS.scope_not_granted)
    expect(message).toMatch(/didn't give Toastmusters Timer permission to see your account/)
    expect(message).toMatch(/click Allow/)
    expect(message).toMatch(/remove and re-add the app in Zoom/)
  })

  it('keeps the copy for the reasons it already knew', () => {
    expect(signinFailureMessage(params('signin=failed&reason=denied'))).toBe(SIGNIN_ERRORS.denied)
    expect(signinFailureMessage(params('signin=failed&reason=state_mismatch'))).toBe(SIGNIN_ERRORS.state_mismatch)
    expect(signinFailureMessage(params('signin=failed&reason=exchange'))).toBe(SIGNIN_ERRORS.exchange)
    expect(signinFailureMessage(params('signin=failed&reason=profile'))).toBe(SIGNIN_ERRORS.profile)
  })

  it('a profile failure and a missing permission no longer read the same', () => {
    expect(SIGNIN_ERRORS.scope_not_granted).not.toBe(SIGNIN_ERRORS.profile)
  })

  it('falls back to the generic line for an unknown or missing reason', () => {
    expect(signinFailureMessage(params('signin=failed&reason=network'))).toBe(SIGNIN_ERRORS.failed)
    expect(signinFailureMessage(params('signin=failed&reason=something_new'))).toBe(SIGNIN_ERRORS.failed)
    expect(signinFailureMessage(params('signin=failed'))).toBe(SIGNIN_ERRORS.failed)
  })

  it('does not treat inherited object keys as reasons', () => {
    expect(signinFailureMessage(params('signin=failed&reason=toString'))).toBe(SIGNIN_ERRORS.failed)
  })
})
