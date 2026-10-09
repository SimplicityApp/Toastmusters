import { describe, it, expect } from 'vitest'
import { readSigninFailure, retryReturnTo, SIGNIN_ERRORS } from './signinFailure'

const params = (query) => new URLSearchParams(query)
const messageFor = (query) => readSigninFailure(params(query))?.message

describe('readSigninFailure', () => {
  it('is null when the URL is not a failed sign-in', () => {
    expect(readSigninFailure(params(''))).toBeNull()
    expect(readSigninFailure(params('reason=denied'))).toBeNull()
    expect(readSigninFailure(params('signin=ok&reason=denied'))).toBeNull()
    expect(readSigninFailure(undefined)).toBeNull()
  })

  it('returns the reason, the message and whether it is a scope issue', () => {
    expect(readSigninFailure(params('signin=failed&reason=denied'))).toEqual({
      reason: 'denied',
      message: SIGNIN_ERRORS.denied,
      scopeIssue: false,
    })
  })

  it('names the missing Zoom permission for reason=scope_not_granted', () => {
    const failure = readSigninFailure(params('signin=failed&reason=scope_not_granted'))
    expect(failure.reason).toBe('scope_not_granted')
    expect(failure.scopeIssue).toBe(true)
    expect(failure.message).toBe(SIGNIN_ERRORS.scope_not_granted)
    expect(failure.message).toMatch(/didn't give Toastmusters Timer permission to see your account/)
    expect(failure.message).toMatch(/click Allow/)
    expect(failure.message).toMatch(/remove and re-add the app in Zoom/)
  })

  it('keeps the copy for the reasons it already knew', () => {
    expect(messageFor('signin=failed&reason=denied')).toBe(SIGNIN_ERRORS.denied)
    expect(messageFor('signin=failed&reason=state_mismatch')).toBe(SIGNIN_ERRORS.state_mismatch)
    expect(messageFor('signin=failed&reason=exchange')).toBe(SIGNIN_ERRORS.exchange)
    expect(messageFor('signin=failed&reason=profile')).toBe(SIGNIN_ERRORS.profile)
  })

  it('a profile failure and a missing permission no longer read the same', () => {
    expect(SIGNIN_ERRORS.scope_not_granted).not.toBe(SIGNIN_ERRORS.profile)
  })

  it('falls back to the generic line for an unknown or missing reason', () => {
    expect(messageFor('signin=failed&reason=network')).toBe(SIGNIN_ERRORS.failed)
    expect(messageFor('signin=failed&reason=something_new')).toBe(SIGNIN_ERRORS.failed)
    expect(messageFor('signin=failed')).toBe(SIGNIN_ERRORS.failed)
  })

  // Analytics should see what the Worker sent, not the copy that was picked.
  it('reports the raw reason even when it shows the generic line', () => {
    const failure = readSigninFailure(params('signin=failed&reason=network'))
    expect(failure.reason).toBe('network')
    expect(failure.scopeIssue).toBe(false)
    expect(readSigninFailure(params('signin=failed')).reason).toBe('failed')
  })

  it('does not treat inherited object keys as reasons', () => {
    expect(messageFor('signin=failed&reason=toString')).toBe(SIGNIN_ERRORS.failed)
  })
})

describe('retryReturnTo', () => {
  it('drops the failure params so a successful retry lands clean', () => {
    expect(retryReturnTo({ pathname: '/account', search: '?signin=failed&reason=denied' })).toBe('/account')
  })

  it('keeps every other param, in order, and the hash', () => {
    expect(
      retryReturnTo({ pathname: '/club/admin', search: '?tab=1&signin=failed&reason=profile&x=2', hash: '#members' })
    ).toBe('/club/admin?tab=1&x=2#members')
  })

  it('leaves a URL without failure params alone', () => {
    expect(retryReturnTo({ pathname: '/timer/app', search: '', hash: '' })).toBe('/timer/app')
    expect(retryReturnTo({ pathname: '/timer/app', search: '?x=1' })).toBe('/timer/app?x=1')
  })
})
