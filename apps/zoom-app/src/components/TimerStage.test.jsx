import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import TimerStage from './TimerStage';

/**
 * The poll winners on the stage (#80, AC-8): "Show on Stage" hands the closed
 * poll's categories to the owner's own TimerStage as `pollWinners`
 * (`[{role, label?, winners: [name, …]}]`), and the stage shows them as plain
 * React over the artwork. No prop, no panel.
 */

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({
  getBackgroundUrl: vi.fn((color) => `/backgrounds/${color}.png`),
  getZoomParticipants: vi.fn(async () => []),
}));

const noop = () => {};

function renderStage(extra = {}) {
  return render(
    <TimerStage
      status="blue"
      elapsedTime={0}
      rules={{ green: 300, yellow: 360, red: 420 }}
      speakerName=""
      role="Standard Speech"
      isRunning={false}
      onStart={noop}
      onContinue={noop}
      onStop={noop}
      onReset={noop}
      onFinish={noop}
      onExit={noop}
      clockHidden={false}
      onToggleClock={noop}
      isSharing={false}
      onToggleShare={noop}
      isPoppedOut={false}
      onTogglePopout={noop}
      canPopout={false}
      onSpeakerNameChange={noop}
      agendaItems={[]}
      activeSpeakerId={null}
      onSelectSpeaker={noop}
      onAddSpeaker={noop}
      onRenameSpeaker={noop}
      clubKit={null}
      badgePlacement={null}
      {...extra}
    />
  );
}

const WINNERS = [
  { role: 'Table Topics Speech', label: 'Best Table Topics Speaker', winners: ['Bob', 'Carol'] },
  { role: 'Standard Speech', label: 'Best Speaker', winners: ['Alice'] },
  { role: 'Table Topics Evaluation', winners: [] },
];

describe('the winners panel on the stage', () => {
  it('names each category\'s winners, every tied name included', () => {
    renderStage({ pollWinners: WINNERS });

    expect(screen.getAllByText(/Best Table Topics Speaker/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Bob/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Carol/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Best Speaker/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Alice/).length).toBeGreaterThan(0);
  });

  it('names an unlabelled category by its role, and says "No votes" when nobody voted in it', () => {
    renderStage({ pollWinners: WINNERS });

    expect(screen.getAllByText(/Table Topics Evaluation/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No votes/i).length).toBeGreaterThan(0);
  });

  it('shows no panel without winners', () => {
    renderStage();
    expect(screen.queryByText(/winners/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No votes/i)).not.toBeInTheDocument();
  });
});
