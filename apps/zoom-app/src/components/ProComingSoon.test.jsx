import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import ProComingSoon from './ProComingSoon';
import { trackEvent } from '../utils/posthog';

vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));

const button = () => screen.getByRole('button', { name: 'Pro (coming soon)' });
const panel = () => screen.queryByRole('dialog', { name: 'Pro is coming soon' });

beforeEach(() => trackEvent.mockClear());

describe('ProComingSoon', () => {
  it('is a greyed, locked Pro button with nothing open', () => {
    render(<ProComingSoon />);
    expect(button()).toHaveClass('text-gray-400');
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).toBeNull();
  });

  it('lists what is coming while pointed at, and closes when the pointer leaves', () => {
    render(<ProComingSoon />);
    fireEvent.mouseEnter(button().parentElement);
    expect(panel()).toBeInTheDocument();
    expect(panel()).toHaveTextContent('Pro is coming soon');
    expect(panel()).toHaveTextContent('Sounds: a chime at each colour, music for breaks');
    expect(panel()).toHaveTextContent("Your club's card sets on every club timer");
    expect(panel()).toHaveTextContent('Voting for Best Table Topics and Best Evaluator');
    expect(panel()).toHaveTextContent("And more: your club's logo, shared timings, meeting history.");
    expect(panel()).toHaveTextContent('The timer itself stays free.');
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    expect(trackEvent).toHaveBeenCalledWith('pro_coming_soon_opened', { trigger: 'hover' });

    fireEvent.mouseLeave(button().parentElement);
    expect(panel()).toBeNull();
  });

  it('stays open after a click until clicked again, Escape, or a click elsewhere', () => {
    render(
      <div>
        <p>elsewhere</p>
        <ProComingSoon />
      </div>
    );
    fireEvent.click(button());
    expect(panel()).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('pro_coming_soon_opened', { trigger: 'click' });
    fireEvent.click(button());
    expect(panel()).toBeNull();

    fireEvent.click(button());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel()).toBeNull();

    fireEvent.click(button());
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(panel()).toBeNull();
  });

  it('records a hover once per mount, not on every pass of the pointer', () => {
    render(<ProComingSoon />);
    fireEvent.mouseEnter(button().parentElement);
    fireEvent.mouseLeave(button().parentElement);
    fireEvent.mouseEnter(button().parentElement);
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});
