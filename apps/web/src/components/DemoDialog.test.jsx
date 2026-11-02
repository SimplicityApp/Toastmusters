import { render, screen, fireEvent } from '@testing-library/react';
import DemoDialog from './DemoDialog';

vi.mock('./YouTubePlayer', () => ({
  default: ({ videoId, page, autoplay }) => <div data-testid="youtube" data-video-id={videoId} data-page={page} data-autoplay={String(autoplay)} />,
}));

const renderDialog = (props = {}) =>
  render(
    <DemoDialog open onClose={() => {}} videoId="abc123" title="The demo" meta="1:55 · start to finish" page="landing" {...props}>
      <a href="https://example.com/install">Add to Zoom</a>
    </DemoDialog>
  );

describe('DemoDialog', () => {
  afterEach(() => { document.body.style.overflow = ''; });

  it('renders nothing, and so loads no player, while closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('youtube')).not.toBeInTheDocument();
  });

  it('shows the title, meta and actions around an autoplaying player once open', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: 'The demo' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'The demo' })).toBeInTheDocument();
    expect(screen.getByText('1:55 · start to finish')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add to Zoom' })).toHaveAttribute('href', 'https://example.com/install');
    const player = screen.getByTestId('youtube');
    expect(player).toHaveAttribute('data-video-id', 'abc123');
    expect(player).toHaveAttribute('data-page', 'landing');
    expect(player).toHaveAttribute('data-autoplay', 'true');
  });

  it('closes from the button, the backdrop and Escape, but not from a click on the card', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    fireEvent.click(screen.getByRole('heading', { name: 'The demo' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close the demo' }));
    fireEvent.click(screen.getByRole('dialog'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('freezes page scroll while open and restores it on close', () => {
    document.body.style.overflow = 'auto';
    const { rerender } = renderDialog();
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<DemoDialog open={false} onClose={() => {}} videoId="abc123" title="The demo" />);
    expect(document.body.style.overflow).toBe('auto');
  });

  it('moves focus to the close button, keeps Tab inside, and returns focus to the opener', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = renderDialog();

    const close = screen.getByRole('button', { name: 'Close the demo' });
    const install = screen.getByRole('link', { name: 'Add to Zoom' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(install).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    rerender(<DemoDialog open={false} onClose={() => {}} videoId="abc123" title="The demo" />);
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
