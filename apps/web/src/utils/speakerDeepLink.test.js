import { parseSpeakerFromSearch, stripSpeakerParams } from './speakerDeepLink';

const ROLES = ['Standard Speech', 'Table Topics Speech', 'Ice Breaker'];

describe('parseSpeakerFromSearch', () => {
  it('returns the role and name when the role is valid', () => {
    expect(parseSpeakerFromSearch('?role=Table%20Topics%20Speech&name=Describe%20a%20perfect%20day', ROLES))
      .toEqual({ role: 'Table Topics Speech', name: 'Describe a perfect day' });
  });

  it('decodes + as a space', () => {
    expect(parseSpeakerFromSearch('?role=Table+Topics+Speech&name=A+perfect+day', ROLES))
      .toEqual({ role: 'Table Topics Speech', name: 'A perfect day' });
  });

  it('returns null for a role the timer does not know', () => {
    expect(parseSpeakerFromSearch('?role=Keynote&name=Jane', ROLES)).toBeNull();
  });

  it('matches the role exactly, not loosely', () => {
    expect(parseSpeakerFromSearch('?role=table%20topics%20speech', ROLES)).toBeNull();
    expect(parseSpeakerFromSearch('?role=Table%20Topics', ROLES)).toBeNull();
  });

  it('returns null when there is no role, even with a name', () => {
    expect(parseSpeakerFromSearch('?name=Jane', ROLES)).toBeNull();
    expect(parseSpeakerFromSearch('', ROLES)).toBeNull();
  });

  it('defaults the name to an empty string', () => {
    expect(parseSpeakerFromSearch('?role=Ice%20Breaker', ROLES)).toEqual({ role: 'Ice Breaker', name: '' });
  });

  it('trims and caps the name at 200 characters', () => {
    const long = 'x'.repeat(250);
    const parsed = parseSpeakerFromSearch(`?role=Ice%20Breaker&name=%20%20${long}%20`, ROLES);
    expect(parsed.name).toBe('x'.repeat(200));
  });

  it('ignores extra params', () => {
    expect(parseSpeakerFromSearch('?utm_source=tt&role=Ice%20Breaker&name=Jane&tab=live', ROLES))
      .toEqual({ role: 'Ice Breaker', name: 'Jane' });
  });

  it('accepts the search string without a leading ?', () => {
    expect(parseSpeakerFromSearch('role=Ice%20Breaker&name=Jane', ROLES))
      .toEqual({ role: 'Ice Breaker', name: 'Jane' });
  });
});

describe('stripSpeakerParams', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('removes role and name but keeps other params and the hash', () => {
    window.history.replaceState(null, '', '/timer/app?utm_source=tt&role=Ice%20Breaker&name=Jane&tab=live#reports');
    stripSpeakerParams();
    expect(window.location.pathname).toBe('/timer/app');
    expect(window.location.search).toBe('?utm_source=tt&tab=live');
    expect(window.location.hash).toBe('#reports');
  });

  it('leaves an empty search when nothing else was there', () => {
    window.history.replaceState(null, '', '/timer/app?role=Ice%20Breaker&name=Jane');
    stripSpeakerParams();
    expect(window.location.search).toBe('');
    expect(window.location.href.endsWith('/timer/app')).toBe(true);
  });

  it('does not touch history when neither param is present', () => {
    window.history.replaceState(null, '', '/timer/app?tab=live');
    const spy = vi.spyOn(window.history, 'replaceState');
    stripSpeakerParams();
    expect(spy).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?tab=live');
    spy.mockRestore();
  });
});
