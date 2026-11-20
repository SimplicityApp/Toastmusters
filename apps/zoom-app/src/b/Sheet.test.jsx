import '@testing-library/jest-dom';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Sheet from './Sheet';

function Harness({ onClose = () => {}, children }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Cards
      </button>
      <Sheet
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Cards"
        description="The card the timer shows at each colour."
      >
        {children ?? (
          <>
            <button type="button">Classic</button>
            <button type="button">Modern</button>
          </>
        )}
      </Sheet>
    </>
  );
}

const openSheet = () => fireEvent.click(screen.getByRole('button', { name: 'Cards' }));

describe('Sheet', () => {
  it('renders nothing while closed', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a labelled modal dialog with its description', () => {
    render(<Harness />);
    openSheet();
    const dialog = screen.getByRole('dialog', { name: 'Cards' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('The card the timer shows at each colour.')).toBeInTheDocument();
  });

  it('moves focus in when it opens, and back to the opener when it closes', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Cards' });
    opener.focus();
    openSheet();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('closes on Escape, on the close button and on the dimmed panel', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    openSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    openSheet();
    fireEvent.click(screen.getByTestId('sheet-backdrop'));

    expect(onClose).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps Tab inside the sheet', () => {
    render(<Harness />);
    openSheet();
    const close = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Modern' });

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('does not close for a press inside the sheet', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Classic' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
