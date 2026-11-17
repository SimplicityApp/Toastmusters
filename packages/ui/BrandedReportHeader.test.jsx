import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import BrandedReportHeader from './BrandedReportHeader.jsx';

// The header's own format. Expected strings are built with it rather than
// written out, so the test does not depend on the machine's locale.
const DATE_FORMAT = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
const day = (when) => when.toLocaleDateString(undefined, DATE_FORMAT);
const subtitle = () => screen.getByTestId('branded-report-header').textContent;

const originalTZ = process.env.TZ;

afterEach(cleanup);
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

// Node applies a TZ change to Date and Intl at once, so one process can play
// every zone. West of UTC is where the old `new Date('2026-11-16')` printed the
// day before; the eastern zones check the fix doesn't push it a day forward.
describe.each([
  'America/Toronto',
  'America/Los_Angeles',
  'Pacific/Honolulu',
  'UTC',
  'Europe/Paris',
  'Asia/Tokyo',
  'Pacific/Kiritimati',
])('BrandedReportHeader in %s', (tz) => {
  beforeEach(() => {
    process.env.TZ = tz;
  });

  it("prints a meeting's date-only date as that calendar day", () => {
    render(<BrandedReportHeader clubName="Claude Test Club" date="2026-11-16" />);

    expect(subtitle()).toContain(`Timing report · ${day(new Date(2026, 10, 16, 12))}`);
    expect(subtitle()).not.toContain(day(new Date(2026, 10, 15, 12)));
  });

  it('prints a Date at its own local day', () => {
    const when = new Date(Date.UTC(2026, 10, 16, 23, 30));
    render(<BrandedReportHeader clubName="Claude Test Club" date={when} />);

    expect(subtitle()).toContain(`Timing report · ${day(when)}`);
  });

  it('prints a timestamp at its own local day', () => {
    const when = Date.UTC(2026, 10, 16, 2, 0);
    render(<BrandedReportHeader clubName="Claude Test Club" date={when} />);

    expect(subtitle()).toContain(`Timing report · ${day(new Date(when))}`);
  });

  it('prints a full ISO date-time at its own local day', () => {
    const iso = '2026-11-16T02:00:00Z';
    render(<BrandedReportHeader clubName="Claude Test Club" date={iso} />);

    expect(subtitle()).toContain(`Timing report · ${day(new Date(iso))}`);
  });
});

describe('BrandedReportHeader', () => {
  it("prints today's date when there is no date", () => {
    render(<BrandedReportHeader clubName="Claude Test Club" />);

    expect(subtitle()).toContain(`Timing report · ${day(new Date())}`);
  });

  it('leaves the date line out for a date it cannot read', () => {
    render(<BrandedReportHeader clubName="Claude Test Club" date="not a date" />);

    expect(subtitle()).toContain('Claude Test Club');
    expect(subtitle()).not.toContain('Timing report');
  });

  it('renders nothing without a club name', () => {
    const { container } = render(<BrandedReportHeader clubName="" date="2026-11-16" />);

    expect(container.innerHTML).toBe('');
  });
});
