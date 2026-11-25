import { memo, lazy, Suspense } from 'react';
import { useLiveTimer } from '../hooks/useLiveTimer';
import { Play, Square, RotateCcw, Eraser, Video, Image, Volume2, Lock, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import SpeakerInput from './SpeakerInput';
import TimerDisplay from './TimerDisplay';
import TimerStage from './TimerStage';
import OverlayModeMenu, { MODE_LABELS } from './OverlayModeMenu';
import TimeInput, { TimeInputModeToggle } from './TimeInput';
import { DEFAULT_CUSTOM_RULES, saveTimeInputMode, BREAK_ROLE, BREAK_QUICK_PICKS } from '@toastmaster-timer/shared';
import { isVideoOverlayMode, isClubBadgeMoved, OVERLAY_MODE_CARD } from '../utils/zoomSdk';
import { SOUNDS_LOCK_MESSAGES } from '../hooks/useSounds';
const EditRulesModal = lazy(() => import('./EditRulesModal'));
const CardImagesModal = lazy(() => import('./CardImagesModal'));
const SoundsModal = lazy(() => import('./SoundsModal'));

// Always on when running the dev server; in a build it takes an explicit
// VITE_ENABLE_DEBUG_PANEL=true. Fail-closed on purpose: the old `!== 'false'`
// test meant an unset variable shipped the panel to production. Resolved at
// module scope so a production build drops the debug chunk entirely.
const DEBUG_PANEL_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEBUG_PANEL === 'true';

const PromptDebugControls = DEBUG_PANEL_ENABLED
  ? lazy(() => import('./PromptDebugControls'))
  : null;

const PREVIEW_COLORS = [
  { color: 'blue', bg: 'bg-blue-500', ring: 'ring-blue-300', label: 'Blue' },
  { color: 'green', bg: 'bg-green-500', ring: 'ring-green-300', label: 'Green' },
  { color: 'yellow', bg: 'bg-yellow-500', ring: 'ring-yellow-300', label: 'Yellow' },
  { color: 'red', bg: 'bg-red-500', ring: 'ring-red-300', label: 'Red' },
];

export default memo(function LiveTab() {
  const {
    isRunning,
    elapsedTime,
    currentStatus,
    currentSpeaker,
    roleOptions,
    agenda,
    activeSpeakerId,
    speakerName,
    selectedRole,
    customRules,
    breakSeconds,
    timeInputMode,
    setTimeInputMode,
    showEditRulesModal,
    setShowEditRulesModal,
    showCardImagesModal,
    setShowCardImagesModal,
    showSoundsModal,
    setShowSoundsModal,
    soundsLockReason,
    setCardImagesGeneration,
    videoState,
    isClearingVideo,
    isSharing,
    isPoppedOut,
    isEnablingVideo,
    previewColor,
    stageClockHidden,
    revealFaceWhenIdle,
    overlayMode,
    readoutPosition,
    readoutVisible,
    clubKit,
    badgePlacement,
    badgeOnCards,
    handleBadgePlacementChange,
    handleAdjustBadgeScale,
    handleToggleBadgeVisible,
    handleResetBadgePlacement,
    handleReadoutPositionChange,
    handleAdjustReadoutScale,
    handleToggleReadoutVisible,
    wantsColorNow,
    desiredStatus,
    debugPanelExpanded,
    sdkStatus,
    lastError,
    debugLogs,
    setDebugLogs,
    canPopout,
    sdkHealthy,
    toggleDebugPanel,
    handleSpeakerChange,
    handleSelectSuggestion,
    handleSelectAgendaSpeaker,
    speakerEntry,
    handleRoleChange,
    handleCustomRuleChange,
    roleExplanation,
    breakExplanation,
    handlePreviewColor,
    handleBreakDurationChange,
    handleStart,
    handleContinue,
    handleStop,
    handleReset,
    resetTooltip,
    handleFinish,
    handleClearVideo,
    handleModeSwitch,
    handleToggleShare,
    handleTogglePopout,
    handleToggleRevealFaceWhenIdle,
    handleToggleStageClock,
    handleTurnVideoOn,
  } = useLiveTimer();

  return (
    <div className="p-4 space-y-4 relative">
      {/* Stage modes cover the whole panel: in share mode every pixel of the app
          is broadcast, so nothing else may stay on screen. */}
      {!isVideoOverlayMode(overlayMode) && (
        <TimerStage
          status={previewColor || currentStatus}
          elapsedTime={elapsedTime}
          rules={currentSpeaker?.rules}
          speakerName={speakerName}
          role={selectedRole}
          isRunning={isRunning}
          onStart={handleStart}
          onContinue={handleContinue}
          onStop={handleStop}
          onReset={handleReset}
          onFinish={handleFinish}
          onExit={() => handleModeSwitch(OVERLAY_MODE_CARD)}
          clockHidden={stageClockHidden}
          onToggleClock={handleToggleStageClock}
          isSharing={isSharing}
          onToggleShare={handleToggleShare}
          isPoppedOut={isPoppedOut}
          onTogglePopout={handleTogglePopout}
          canPopout={canPopout}
          onSpeakerNameChange={handleSpeakerChange}
          agendaItems={agenda}
          activeSpeakerId={activeSpeakerId}
          onSelectSpeaker={handleSelectAgendaSpeaker}
          speakerEntry={speakerEntry}
          clubKit={clubKit}
          badgePlacement={badgePlacement}
        />
      )}

      {/* Clear-background escape hatch + overlay mode menu.
          In the flow rather than floating: these carry their labels now, and two
          labelled buttons pinned over the top-right corner sit on whatever the
          panel is showing underneath. Invisible in the stage modes regardless,
          since TimerStage is fixed inset-0 above this. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Always available, in every mode: the point of it is to work when
            something of ours is stuck, which is exactly when the mode-specific
            paths have already failed.

            Labelled rather than left to a tooltip. An eraser icon says an
            action is destructive but not what it destroys, and someone whose
            video is stuck is looking for a way out, not hovering to find one. */}
        <button
          onClick={handleClearVideo}
          disabled={isClearingVideo}
          className="flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-gray-700 text-sm font-medium transition-colors"
          aria-label="Clear the timer background from my video"
        >
          <Eraser className="h-4 w-4 flex-shrink-0" />
          {isClearingVideo ? 'Clearing…' : 'Clear Background'}
        </button>
        <OverlayModeMenu
          value={overlayMode}
          onChange={handleModeSwitch}
          revealFaceWhenIdle={revealFaceWhenIdle}
          onToggleRevealFaceWhenIdle={handleToggleRevealFaceWhenIdle}
          onCustomizeCards={() => setShowCardImagesModal(true)}
        />
      </div>

      {/* Video off warning banner - Always visible when video is off */}
      {videoState === false && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1">
            <AlertTriangle className="h-5 w-5 text-yellow-600 flex-shrink-0" />
            <p className="text-sm text-yellow-800 font-medium">
              Your video is turned off. Please turn on your video to show the timer on it.
            </p>
          </div>
          <button
            onClick={handleTurnVideoOn}
            disabled={isEnablingVideo}
            className="bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 text-white font-semibold py-2 px-4 rounded-lg flex items-center gap-2 transition-colors flex-shrink-0"
          >
            {isEnablingVideo ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                <span>Turning On...</span>
              </>
            ) : (
              <>
                <Video className="h-4 w-4" />
                <span>Turn Video On</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* Debug Panel - Only show if enabled via feature flag */}
      {DEBUG_PANEL_ENABLED && (
        <div className="bg-gray-50 border border-gray-300 rounded-lg overflow-hidden">
          <button
            onClick={toggleDebugPanel}
            className="w-full flex items-center justify-between p-3 bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className={`h-4 w-4 ${lastError ? 'text-red-500' : 'text-green-500'}`} />
              <span className="text-sm font-semibold text-gray-700">Debug Panel</span>
              {lastError && (
                <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded">Error</span>
              )}
            </div>
            {debugPanelExpanded ? (
              <ChevronUp className="h-4 w-4 text-gray-600" />
            ) : (
              <ChevronDown className="h-4 w-4 text-gray-600" />
            )}
          </button>

          {debugPanelExpanded && (
          <div className="p-3 space-y-2 text-xs">
            {lastError && (
              <div className="bg-red-50 border border-red-200 rounded p-2">
                <div className="font-semibold text-red-800 mb-1">Error:</div>
                <div className="text-red-700">{lastError}</div>
              </div>
            )}

            {sdkStatus && (
              <div className="space-y-1">
                <div className="font-semibold text-gray-700 mb-2">SDK Status:</div>
                {/* Only what is wrong. A wall of green "Yes" rows takes the eye
                    the same effort to scan as one problem hiding among them. */}
                {sdkHealthy ? (
                  <div className="px-2 py-1 rounded bg-green-100 text-green-800">
                    SDK ready — all {sdkStatus.apiCount} APIs available
                  </div>
                ) : (
                  <div className="space-y-1">
                    {!sdkStatus.sdkExists && (
                      <div className="px-2 py-1 rounded bg-red-100 text-red-800">
                        SDK Exists: No — not running inside a Zoom client
                      </div>
                    )}
                    {sdkStatus.sdkExists && !sdkStatus.initialized && (
                      <div className="px-2 py-1 rounded bg-red-100 text-red-800">Initialized: No</div>
                    )}
                    {sdkStatus.sdkExists && !sdkStatus.available && (
                      <div className="px-2 py-1 rounded bg-red-100 text-red-800">
                        Available: No — config() was refused
                      </div>
                    )}
                    {sdkStatus.missingApis?.length > 0 && (
                      <>
                        <div className="text-gray-600">
                          {sdkStatus.apiCount - sdkStatus.missingApis.length}/{sdkStatus.apiCount} APIs
                          available. Missing:
                        </div>
                        {sdkStatus.missingApis.map((api) => (
                          <div
                            key={api.name}
                            className={`px-2 py-1 rounded ${api.required ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'}`}
                          >
                            {api.name} — {api.purpose}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}

                {sdkStatus.availableMethods && sdkStatus.availableMethods.length > 0 && (
                  <div className="mt-2">
                    <div className="font-semibold text-gray-700 mb-1">Available Methods:</div>
                    <div className="text-gray-600 font-mono text-xs bg-gray-100 p-2 rounded max-h-32 overflow-y-auto">
                      {sdkStatus.availableMethods.join(', ')}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="pt-2 border-t border-gray-200">
              <div className="text-gray-600 mb-2">
                <div>Video State: {videoState === null ? 'Unknown' : videoState ? 'ON' : 'OFF'}</div>
                <div>Current Status: {currentStatus || 'None'}</div>
                <div>Color On Tile: {wantsColorNow ? `Yes (${desiredStatus})` : 'No'}</div>
                <div>Overlay Mode: {MODE_LABELS[overlayMode] || overlayMode}</div>
                <div>App Shared: {sdkStatus?.appShareActive ? 'Yes' : 'No'}</div>
                <div>Popped Out: {sdkStatus?.appPoppedOut ? 'Yes' : 'No'}</div>
              </div>

              {/* Lazy so the prompt scheduler UI never ships inside the main
                  chunk of a production build with the panel disabled. */}
              <Suspense fallback={null}>
                <PromptDebugControls />
              </Suspense>

              {/* Debug Logs */}
              <div className="mt-3">
                <div className="font-semibold text-gray-700 mb-2">Debug Logs ({debugLogs.length}):</div>
                <div className="bg-gray-900 text-gray-100 p-2 rounded font-mono text-xs max-h-48 overflow-y-auto">
                  {debugLogs.length === 0 ? (
                    <div className="text-gray-500">No logs yet...</div>
                  ) : (
                    <>
                      {debugLogs.map((log, index) => (
                        <div
                          key={index}
                          className={`mb-1 ${
                            log.type === 'error' ? 'text-red-400' :
                            log.type === 'warn' ? 'text-yellow-400' :
                            'text-gray-300'
                          }`}
                        >
                          <span className="text-gray-500">[{log.timestamp}]</span>{' '}
                          <span>{log.message}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
                {debugLogs.length > 0 && (
                  <button
                    onClick={() => setDebugLogs([])}
                    className="mt-2 text-xs text-gray-600 hover:text-gray-800 underline"
                  >
                    Clear Logs
                  </button>
                )}
              </div>
            </div>
          </div>
          )}
        </div>
      )}

      <SpeakerInput
        value={speakerName}
        onChange={handleSpeakerChange}
        onRoleChange={handleRoleChange}
        selectedRole={selectedRole}
        roleOptions={roleOptions}
        onEditRules={() => setShowEditRulesModal(true)}
        agendaItems={agenda}
        onSelectSuggestion={handleSelectSuggestion}
        entry={speakerEntry}
      />

      {selectedRole !== 'Custom' && selectedRole !== BREAK_ROLE && (
        <p className="text-xs text-gray-500 mt-1">
          Timing rules: {roleExplanation}
        </p>
      )}

      {selectedRole === BREAK_ROLE && (
        <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 space-y-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-700">Break Length</h3>
            <TimeInputModeToggle mode={timeInputMode} onModeChange={(m) => { saveTimeInputMode(m); setTimeInputMode(m); }} />
          </div>
          <div className="flex justify-center gap-2">
            {BREAK_QUICK_PICKS.map((seconds) => (
              <button
                key={seconds}
                onClick={() => handleBreakDurationChange(seconds)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  breakSeconds === seconds
                    ? 'bg-blue-500 text-white'
                    : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100'
                }`}
              >
                {Math.round(seconds / 60)} min
              </button>
            ))}
          </div>
          <div className="flex flex-col items-center gap-2">
            <TimeInput layout="inline" label="Custom" value={breakSeconds} onChange={handleBreakDurationChange} />
          </div>
          <p className="text-xs text-gray-500 text-center">{breakExplanation}</p>
        </div>
      )}

      {selectedRole === 'Custom' && (
        <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 space-y-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-700">Custom Timing Rules</h3>
            <TimeInputModeToggle mode={timeInputMode} onModeChange={(m) => { saveTimeInputMode(m); setTimeInputMode(m); }} />
          </div>
          <div className="flex flex-col items-center gap-2">
            <TimeInput layout="inline" label="Green" value={customRules.green} onChange={(v) => handleCustomRuleChange('green', v)} />
            <TimeInput layout="inline" label="Yellow" value={customRules.yellow} onChange={(v) => handleCustomRuleChange('yellow', v)} />
            <TimeInput layout="inline" label="Red" value={customRules.red} onChange={(v) => handleCustomRuleChange('red', v)} />
            <TimeInput layout="inline" label="Grace" value={customRules.graceAfterRed ?? DEFAULT_CUSTOM_RULES.graceAfterRed} onChange={(v) => handleCustomRuleChange('graceAfterRed', v)} />
          </div>
          {customRules.yellow <= customRules.green && (
            <div className="text-xs text-red-600 mt-2">
              Yellow must be greater than Green
            </div>
          )}
          {customRules.red <= customRules.yellow && (
            <div className="text-xs text-red-600 mt-2">
              Red must be greater than Yellow
            </div>
          )}
        </div>
      )}

      <TimerDisplay
        elapsedTime={elapsedTime}
        status={previewColor || currentStatus}
        rules={currentSpeaker?.rules}
        readoutPosition={isVideoOverlayMode(overlayMode) ? readoutPosition : null}
        onReadoutPositionChange={handleReadoutPositionChange}
        readoutVisible={readoutVisible}
        onToggleReadoutVisible={handleToggleReadoutVisible}
        onAdjustReadoutScale={handleAdjustReadoutScale}
        clubKit={badgeOnCards ? clubKit : null}
        badgePlacement={badgePlacement}
        badgeMoved={isClubBadgeMoved()}
        onBadgePlacementChange={handleBadgePlacementChange}
        onAdjustBadgeScale={handleAdjustBadgeScale}
        onToggleBadgeVisible={handleToggleBadgeVisible}
        onResetBadgePlacement={handleResetBadgePlacement}
      />

      {!isRunning && (
        <div className="flex items-center justify-center gap-3">
          <span className="text-xs text-gray-500">Preview:</span>
          {PREVIEW_COLORS.map(({ color, bg, ring, label }) => (
            <button
              key={color}
              onClick={() => handlePreviewColor(color)}
              disabled={videoState === false}
              className={`w-8 h-8 rounded-full ${bg} transition-all ${
                previewColor === color ? `ring-2 ${ring} scale-110` : 'opacity-70 hover:opacity-100'
              } ${videoState === false ? 'cursor-not-allowed opacity-30' : ''}`}
              data-tooltip={`Preview ${label}`}
            />
          ))}
          {/* Same entry point as the web app; the OverlayModeMenu keeps its
              own Card Images… item for discovery from the mode settings. */}
          <button
            onClick={() => setShowCardImagesModal(true)}
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            data-tooltip="Customize card images"
            aria-label="Customize card images"
          >
            <Image className="h-4 w-4" />
          </button>
          {/* Shown even when locked, so free users can see what Pro adds. The
              modal still opens; its controls are what is locked. */}
          <button
            onClick={() => setShowSoundsModal(true)}
            className={`relative p-1.5 rounded-lg hover:bg-gray-100 transition-colors ${
              soundsLockReason ? 'text-gray-300 hover:text-gray-400' : 'text-gray-500 hover:text-gray-700'
            }`}
            data-tooltip={soundsLockReason ? SOUNDS_LOCK_MESSAGES[soundsLockReason] : 'Sounds'}
            aria-label={soundsLockReason ? `Sounds (locked): ${SOUNDS_LOCK_MESSAGES[soundsLockReason]}` : 'Sounds'}
          >
            <Volume2 className="h-4 w-4" />
            {soundsLockReason && (
              <Lock className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 text-gray-500" aria-hidden="true" />
            )}
          </button>
        </div>
      )}

      <div className="space-y-2 pb-20">
        {/* When timer is running, show STOP button */}
        {isRunning ? (
          <div className="flex gap-2">
            <button
              onClick={handleStop}
              data-tooltip="Pause the timer (can be resumed later)"
              className="flex-1 bg-red-500 hover:bg-red-600 text-white font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors"
            >
              <Square className="h-5 w-5" />
              STOP
            </button>
            <button
              onClick={handleFinish}
              data-tooltip="Complete the current speech and save it to reports"
              className="flex-1 bg-blue-500 hover:bg-blue-600 text-white font-semibold py-3 px-4 rounded-lg transition-colors"
            >
              FINISH
            </button>
          </div>
        ) : (
          /* When timer is not running */
          elapsedTime === 0 ? (
            /* Start state: no timing started at all - only START and RESET */
            <>
              <div className="flex gap-2">
                <button
                  onClick={handleStart}
                  disabled={videoState === false}
                  data-tooltip="Start the timer for the current speaker"
                  className={`flex-1 font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors ${
                    videoState === false
                      ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      : 'bg-green-500 hover:bg-green-600 text-white'
                  }`}
                >
                  <Play className="h-5 w-5" />
                  START
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleReset}
                  disabled={isClearingVideo}
                  data-tooltip={resetTooltip}
                  data-tooltip-direction="down"
                  className="flex-1 bg-gray-500 hover:bg-gray-600 disabled:opacity-50 text-white font-semibold py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors"
                >
                  <RotateCcw className="h-4 w-4" />
                  RESET
                </button>
              </div>
            </>
          ) : (
            /* Continue state: timing started and then stopped - CONTINUE, RESET, and FINISH */
            <>
              <div className="flex gap-2">
                <button
                  onClick={handleContinue}
                  disabled={videoState === false}
                  data-tooltip="Resume the timer from where it was stopped"
                  className={`flex-1 font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors ${
                    videoState === false
                      ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      : 'bg-green-500 hover:bg-green-600 text-white'
                  }`}
                >
                  <Play className="h-5 w-5" />
                  CONTINUE
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleReset}
                  disabled={isClearingVideo}
                  data-tooltip={resetTooltip}
                  data-tooltip-direction="down"
                  className="flex-1 bg-gray-500 hover:bg-gray-600 disabled:opacity-50 text-white font-semibold py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors"
                >
                  <RotateCcw className="h-4 w-4" />
                  RESET
                </button>
                <button
                  onClick={handleFinish}
                  data-tooltip="Complete the current speech and save it to reports"
                  data-tooltip-direction="down"
                  className="flex-1 bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
                >
                  FINISH
                </button>
              </div>
            </>
          )
        )}
      </div>

      {showEditRulesModal && (
        <Suspense fallback={null}>
          <EditRulesModal
            isOpen={showEditRulesModal}
            onClose={() => setShowEditRulesModal(false)}
          />
        </Suspense>
      )}

      {showCardImagesModal && (
        <Suspense fallback={null}>
          <CardImagesModal
            isOpen={showCardImagesModal}
            onClose={() => setShowCardImagesModal(false)}
            onImagesChanged={() => setCardImagesGeneration((generation) => generation + 1)}
          />
        </Suspense>
      )}

      {showSoundsModal && (
        <Suspense fallback={null}>
          <SoundsModal isOpen={showSoundsModal} onClose={() => setShowSoundsModal(false)} />
        </Suspense>
      )}
    </div>
  );
});
