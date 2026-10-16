# Tutorial videos, batch 1: plan and voiceover scripts

Five short videos for a dedicated `/tutorials` page and the landing page's "More videos" section.
Written 2026-10-13. Nothing here is recorded yet.

## Why these five

PostHog, last 30 days (small base, so direction not proof): 243 users opened the app in a meeting,
66 pressed START, 28 finished a speech. Agenda import (5 users), report sharing (3) and mode
switching (10) are valuable and rarely found. Video 1 targets the open-to-START drop. Videos 2, 3
and 5 target the features that are not being discovered. Video 4 targets the Table Topics
generator, which 23 users already use.

| # | Slug | Title | Target length |
|---|---|---|---|
| 1 | `first-speech` | Time your first speech | 60–65 s |
| 2 | `display-modes` | Three ways to show the timer | 65–70 s |
| 3 | `agenda` | Load your agenda in 30 seconds | 50 s |
| 4 | `table-topics` | Run Table Topics | 50 s |
| 5 | `report` | Share the timing report | 35–40 s |

Held for later: 6 on-camera readout (resize, move, hide), 7 own background between speeches,
8 browser timer, 9 and 10 Club Pro (wait for Zoom's approval of the Pro update).

## Production pipeline (reuses the 2026-10-01 demo build)

The earlier demo is the template. Its scripts are in `apps/web/public/video/tmp/build-scripts/`
(git-ignored). The raw takes are in `test-runs/2026-10-01-demo-video/rec/`.

1. **Record** the Zoom window with `screencapture -v -R<window>` (retina, 3456×1998 source). The
   `zoom-app-testing` skill's `click.sh` and `zoom-front.sh` drive the clicks and refuse to act if
   Zoom is not frontmost. One take per scene, with a run log in `test-runs/<date>-tutorial-videos/`.
2. **Cut** with `render.py`: a virtual camera pans and zooms into 1920×1080 at 30 fps, with
   speed ramps and a "sped up" badge for dead time (a 5–7 minute speech cannot be real time).
3. **Voiceover**: one ElevenLabs take per video with word timestamps, split into lines and placed
   at cues (`split_vo.py`, `place_vo.py`). The colour words ("Green", "Yellow", "Red") are locked
   to the frame where the colour changes. Whisper is not installed here and is not needed, since
   ElevenLabs returns timings.
4. **Captions** burned in as a lower third (`assemble.py`), plus a `.srt`. Loudness normalised to
   -16 LUFS. A 2 s end card: "Free in the Zoom App Marketplace" with the Add to Zoom call to action.
5. **Outputs** per video: `<slug>.mp4` (1080p30), `<slug>.srt`, `<slug>-poster.jpg`.

Known gap: the earlier build's `vo/` and `ov/` folders (generated voice lines, overlay images) are
not on disk. They are regenerated, not recovered. The Oct 1 raw takes (`agenda.mov`, `report.mov`,
`rules.mov`, `stage*.mov`, `live.mov`) may be reusable for videos 3 and 5 only if the UI has not
changed since. I will compare against the current app before reusing any of it.

## Recording plan

Videos 1, 2, 3 and 5 are one chained Zoom session of about 30 minutes, because each take sets up the
next. Video 4 is browser only and is recorded with Playwright's own video capture, so it does not
use your screen.

| Order | Take | Needs | Wall-clock |
|---|---|---|---|
| A | 3 Agenda: import, reorder, speaker picker | at least two other participants in the meeting | 3 min |
| B | 1 First speech: pick speaker, START, green, yellow, red, FINISH | Standard Speech, real 5:00 / 6:00 / 7:00 | 8 min |
| C | 2 Modes: menu, Stage (share, pop out), Card, Timer + Camera | a second speaker running | 5 min |
| D | 5 Report: the Report tab after the finished speeches | none | 2 min |
| E | 4 Table Topics, in the browser | production `/tabletopics` | 10 min, headless |

Record against the **production** Zoom app, not dev. Dev shows the BETA badge and the Debug Panel.

### Setup and restore (the Oct 1 run changed these and put them back)
- Back up the agenda and the report to a file first, restore them afterwards.
- Uncheck "Show my own background" for the takes, to avoid Zoom's confirm dialog on each switch.
  Re-check it afterwards.
- Note the current display mode and card images, and restore them.
- Use demo names (Sarah, Liam, Maria), as before.

### Things that will bite, from the Oct 1 findings
- **Report copy in Zoom:** Copy Report to Clipboard shows a "Clipboard access is not available"
  box with the text to copy by hand. The Oct 1 run saw this. I will recheck before recording,
  and the script for video 5 is written to match what the app does. The landing page's step 6
  says "One click copies it", which is not what the Zoom client does.
- **Stage picker:** re-picking the current speaker in the Full-Screen Timer restarts their timing
  and drops the running speech from the Report. Video 2 will not touch the stage picker.
- **Readout position:** the count-up readout overlaps the Toastmasters logo on Classic and Custom
  cards. Use a card style where it does not, or keep to Timer + Camera.
- **End meeting & share** is club only. Video 5 does not show it.

## Scripts

Pace: about 2.6 words a second, with pauses over the on-screen actions. Cue times are targets and
get re-placed from the real VO timings. In the VO text the brand is spelled "Toast-musters" so the
voice says it right. The captions read "Toastmusters".

### 1. Time your first speech (target 62 s)

| Cue | On screen | VO |
|---|---|---|
| 0:00 | Zoom meeting, Apps button | You've just been given the Timer role. Here's the whole job, in about a minute. |
| 0:06 | Apps panel, open the app | Open Apps in your Zoom meeting, and pick Toast-musters Timer. You add it once, and it's there in every meeting after that. |
| 0:17 | Live tab, speaker picker, speech type | Choose the speaker and the speech type. Your club's green, yellow and red times load by themselves. |
| 0:27 | Click START | Press Start when the speaker begins. |
| 0:31 | Sped-up run, badge | The timer counts up, and your video background follows it. So the speaker can see it, and so can everyone else. |
| 0:40 | Colour change, locked | Green. |
| 0:44 | Colour change, locked | Yellow. |
| 0:48 | Colour change, locked | Red. |
| 0:52 | Click FINISH, next speaker loads | Press Finish when they're done. The time is saved, and the next speaker is ready. |
| 0:58 | End card | Toast-musters Timer. Free in the Zoom App Marketplace. |

Words: 99, about 38 s of speech. Fast-forward the dead time; the badge says "Sped up".

### 2. Three ways to show the timer (target 68 s)

| Cue | On screen | VO |
|---|---|---|
| 0:00 | Mode menu closed, then open | The timer can show up three ways. Open the mode menu at the top of the Live tab, and pick the one that suits your club. |
| 0:12 | Timer Stage, full colour, Share and pop-out buttons | Timer Stage fills the panel with colour, and leaves your camera alone. Share it, so everybody sees the same signal. Or pop it out, and park it on a second screen. |
| 0:28 | Zoom tile turned to a colour card | Timer Card turns your video tile into one big colour card. It's the classic look, where speakers watch your tile. |
| 0:41 | Person with colour behind them | Timer plus Camera keeps your face on screen, and puts the colour behind you. You can still nod, and give hand signals. |
| 0:54 | Switching between modes | Switch any time, even in the middle of a meeting. The app remembers your choice for next time. |
| 1:03 | End card | Toast-musters Timer. Free in the Zoom App Marketplace. |

Words: 117, about 45 s of speech. Shown on camera only if you agree (see the decisions in the chat message).

### 3. Load your agenda in 30 seconds (target 50 s)

| Cue | On screen | VO |
|---|---|---|
| 0:00 | Agenda tab, empty | Typing every speaker, role and time limit takes minutes. Skip it. |
| 0:05 | Import, paste the EasySpeak page | Open the Agenda tab, tap Import, and paste your meeting roles. Or the whole EasySpeak page. |
| 0:15 | Agenda fills in | Every speaker comes in with the right role, and the right time limits. |
| 0:21 | Drag a row | Drag them into running order. |
| 0:26 | Live tab, name field, list open | Back on the Live tab, tap the name field. Your agenda is on top, and the people in the meeting are below. |
| 0:37 | Type a new name, Enter | Someone who isn't on the list? Type their name, and press Enter. |
| 0:43 | End card | Toast-musters Timer. Free in the Zoom App Marketplace. |

Words: 79, about 30 s of speech. Needs other people in the meeting for the "people in the meeting" list.

### 4. Run Table Topics (target 50 s)

| Cue | On screen | VO |
|---|---|---|
| 0:00 | `/tabletopics`, a set of three questions | Table Topics is the part of the meeting where nobody knows what's coming. Here's how to run it. |
| 0:08 | Click New set | The generator gives you a set of three questions. Tap New set for another round. |
| 0:16 | Click a category chip | Pick a category, and the questions follow. There are twenty. |
| 0:23 | Click Copy all | Copy all puts the three questions in your clipboard, ready for the meeting chat. |
| 0:31 | Click Time this, the timer opens | Time this opens the timer with the Table Topics rules already set. Green at one minute. Yellow at a minute and a half. Red at two. |
| 0:46 | End card | Toast-musters Timer. Free in the Zoom App Marketplace. |

Words: 83, about 32 s of speech. To check at recording: whether Time this opens the Zoom app or the browser timer from a
plain browser. The Oct 1 run landed on the browser timer. The script says only "opens the timer".

### 5. Share the timing report (target 38 s)

| Cue | On screen | VO |
|---|---|---|
| 0:00 | Report tab with three speeches | At the end of the meeting, everyone wants to know. Who made their time? |
| 0:06 | Report table, each row's time and status | Open the Report tab. Every speaker is listed with their time, and whether they finished inside the limits. |
| 0:16 | Click Copy Report | Tap Copy Report. It shows the report as text. |
| 0:22 | Select, copy, paste into the Zoom chat | Copy it, and paste it into the meeting chat. |
| 0:29 | End card | Toast-musters Timer. Free in the Zoom App Marketplace. |

Words: 50, about 19 s of speech. If the one-click copy has been fixed by then, the third line becomes "Tap Copy Report,
and paste it into the meeting chat."

## Per-video rules
- Start on the action within 1 second. No logo intro.
- No Debug Panel, no BETA badge, no personal names beyond the demo names.
- Every line of VO is also a caption. Colour words appear on the exact frame the colour changes.
- Keep a still of the first frame as the poster, with the title in Plus Jakarta Sans on the cream
  background (#FAF7F2).

## After recording
1. I publish the files to a folder you can open, and a one-page contact sheet of each video.
2. You review and approve (or send notes by timestamp).
3. Hosting: either upload to YouTube (the page then uses the existing `YouTubePlayer`, which fires
   `full_demo_played`), or self-host the mp4 in `apps/web/public/video/`. I'd upload to YouTube,
   since 4 of the 5 are over 40 s and the repo already carries a 17 MB demo file.
4. I build the `/tutorials` page and the landing "More videos" section, with tests, as a PR.

## Built 2026-10-13 (changes from the plan above)

Videos 1–5 are built locally in `test-runs/2026-10-13-tutorial-videos/out/` (git-excluded). The
scripts, per-line raw voice files and build scripts are in `…/build/`. Re-run any video with
`python3 build_<name>.py`, and with the ElevenLabs lines via `VOICE_DIR=vo-eleven`
(`out/voiceover-scripts.md` has the lines and file names).

- **Footage.** The prod Agenda and Report hold a real club meeting and the app cannot delete a
  single row, so videos 1, 3 and 5 reuse the 2026-10-01 takes (demo names). Video 2 has fresh prod
  takes. Video 4 is a Playwright recording of production `/tabletopics`.
- **Mode names are the app's own:** Timer + Camera, Timer Only, Full-Screen Timer. The landing page
  still says Timer Stage / Timer Card; fix that page or the app label separately.
- **Video 1** uses an Ice Breaker run (4:00 / 5:00 / 6:00) and says no numbers. The apps step shows a
  highlight ring on Zoom's Apps button.
- **Video 3** drops "type a name and press Enter" and "the people in the meeting", because the demo
  meeting has no other participants. The name field shows the agenda names.
- **Video 5** says "Tap Copy Report to Clipboard. The report opens as text.", which is what the
  Zoom client does today (clipboard fallback box). The landing page's "One click copies it" is wrong for Zoom.
- **Zoom prompts.** Every mode switch raises Zoom's "wants to delete your video filter" prompt in
  the real client. The fresh takes were framed to avoid it (the prompt was answered before each take).
- Not yet done: the `/tutorials` page, the landing "More videos" section, hosting.
- **Follow-up (2026-10-13):** the chair that showed in the Zoom tile of the reused takes is patched
  out with clean card art from the fresh footage (`build/chairfix.py`, videos 1, 2 and 3; video 3's
  opening raw-camera tile is replaced by the blue card). The ending card now uses the layout of
  `toastmusters-timer-demo-web.mp4` (logo, title, tagline, QR, "Free in the Zoom App Marketplace")
  with the Timer's blue Toastmasters card in place of the face tile (`build/endcard.py`).
- **Ending card, final (2026-10-13):** design C, three cascading signal cards (green 04:00, yellow 05:00,
  red 06:00) beside the logo, title, tagline and QR. The title is now **Toastmasters Timer** (the
  Marketplace keyword), on the card, in the closing voice line and in the `.srt`. The demo
  `toastmusters-timer-demo-web.mp4` ending got the same title change (only the last keyframe-to-end
  stretch was re-encoded; audio untouched; original kept in `test-runs/2026-10-13-tutorial-videos/demo-patch/backup/`).
  The demo's mid-video name card (~21.7–22.7 s) says Toastmasters Timer too. Every ending now shows the
  site address `www.toastmusters.com` (the canonical host in `sitemap.xml`) and a QR code that points to it
  (generated with macOS CoreImage, decoded back to verify). Demo patch: `demo-patch/patch_demo.py`.
  Still saying the old name: the demo's spoken line ("Toast-musters", not re-dubbed) and the YouTube
  copy (`D_9bbL9eSJY`).
