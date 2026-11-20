# WebSoundEdit 1.0 beta user guide

WebSoundEdit combines sample editing, multitrack arrangement and live performance in one browser workbench. The waveform editor contains a bounded editable session. Long recordings use a separate disk archive. Native project saves preserve the editable session; rendered audio exports contain the sound you choose to print.

[Open WebSoundEdit](https://djshellshoxxx.github.io/websoundedit/) · [Scripting and batch audio](SCRIPTING.md) · [Action recorder and macros](MACROS.md) · [API reference](API.md) · [Browser support](BROWSER_SUPPORT.md) · [Audacity compatibility](AUDACITY.md) · [REAPER compatibility](REAPER.md) · [Verification](VERIFICATION.md)

## 1. Find your way around

The center of the workbench is the arrangement: track controls on the left, colorful clip waveforms on the right, with transport, selection and zoom nearby. **Shape the sound** contains selection tools and the creative Effects rack. **Hide sound tools** collapses the whole inspector so the waveform has more room.

**Options** is an addressable view within the same app. Opening `#options/general`, changing sections or returning with Back/Close keeps the project alive. Help uses stable chapter routes such as `#help/effects` and `#help/macros`. **Macros** and **Live performance** have their own views.

Hover or focus a control for usage guidance. Effect tips explain the parameter, units/range and how the selected mode applies it. Press Escape to dismiss a visible tip. Turn **Show guidance on hover and keyboard focus** off in Options to disable tips globally; labels and the guide remain available.

Use **Ctrl K** to search workbench actions. On macOS, Command substitutes for Control. Keyboard shortcuts can be edited in Options. Save settings JSON for a portable copy of preferences and definitions.

### Main Options sections

| Section | What it controls |
| --- | --- |
| General & theme | Ten-theme gallery and selector; guidance preference; settings import/export. |
| Audio input | Microphone/interface or display-audio source, device rescan, physical channel indices, gain, processing requests and reported rate/latency. |
| Audio output | Actual monitoring output device, available device picker and monitoring layout, distinct from the rendered project layout. |
| Channel layout | Project render layout and explicit canonical speaker order. |
| MIDI & pedals | Device ports, sample note triggers, continuous CC mappings and locally armed command/macro actions. |
| Keyboard shortcuts | Reassign workbench actions without duplicating bindings. |
| Macros & import triggers | Links to recorded/script workflows and local trigger configuration. |
| Recording & storage | Archive capability, usage and available-space estimates. |
| Streaming companion | Explicit local connection, named destination, advertised encoding profile and real status. |
| Help & recovery | Linked guidance and an explicit recovery-clear action. |

The quick theme selector and Options theme choice stay synchronized. Device IDs and requested preferences may be saved, but a saved file does not grant permissions, start input/recording, reconnect a companion or arm triggers.

The ten palettes are **Studio**, **Daylight**, **Midnight**, **Terminal**, **Graphite**, **Ocean**, **Aurora**, **Ember**, **Paper** and **High contrast**. Daylight and Paper provide cool and warm light workspaces; the other palettes provide dark alternatives. Select a gallery card or use either theme selector. Changing the appearance preserves project audio, selection and effect settings.

## 2. Import, select and zoom a sample

Choose **Import** or drag local audio files onto the workbench. The demo contains three locally synthesized tracks, so it can be explored without uploading anything. Ordinary decoded audio is converted to the current project sample rate.

If a surround source has no identifiable speaker mask, Auto import rejects it without downmixing. When you know its order, choose **Options → General & theme → Imported file speaker layout** and explicitly declare 5.1 or 7.1, then import again. The declaration must match the actual channel count and any known speaker mask; it does not convert channels. Return to Auto for ordinary imports. Project output layout is a separate rendering choice.

Click a clip or drag across its waveform to select a region. IN/OUT fields provide exact times relative to that clip; the clip's placement on the arrangement is absolute project time. Double-click selects the whole clip. Clear a region selection to operate on the whole selected clip.

**Selection zoom** fits the region in the visible waveform without changing its boundaries or samples. Fit restores a project view; zoom and the scrollbar change only the view. Collapse the sound inspector when a narrow display needs more waveform space.

The channel selector shows meaningful speaker names. Choose left/right for stereo, an individual named speaker for surround, or **Choose channels…** for an explicit set. A channel-specific edit preserves all unselected channels. Operations that change duration or channel layout require all channels.

Alt-drag moves a clip in project time. Track gain, pan, mute and solo affect the arrangement's render. Overlapping clips mix; editing one clip does not silently shift its neighbors. Markers and beat snapping help place transitions.

## 3. Preview, compare and commit an edit

Select an interval and choose a tool such as Gain, Pitch shift, Time stretch, Fade, EQ or Trim quiet ends. A parameter change renders a temporary preview. **Audition** plays that preview, **A/B** compares it with the original and **Apply** commits one undoable edit.

The waveform overlay, detail view and spectrum use actual audio samples. A preview is discarded when its source or selection changes. A project/audio export includes committed edits; a temporary selection preview needs Apply first.

**Trim quiet ends** removes sufficiently quiet material at the beginning and end. **Remove silence** can remove quiet regions inside the sound. Their threshold, duration and padding controls have different purposes; audition the result before committing. Entirely silent material can remain unchanged when no useful retained interval is found.

Pitch shift and time stretch aim to change pitch and duration independently. Speed/varispeed changes both together. This beta's time/pitch processing supports mono and stereo; unsupported surround operations report their limitation explicitly. Sample-peak normalization and limiting do not implement broadcast LUFS targeting or oversampled true-peak measurement.

Undo and Redo restore editor state within the bounded history. Downloading an export, sending a MIDI message, capturing an archive or broadcasting packets is an external action; editor Undo does not reverse it.

### Precise silence, zero crossings and channel extraction

**Insert silence…** in the edit toolbar opens an exact clip-relative position and a duration in seconds. The default position is the playhead, clamped to the selected clip. The command inserts silence into every channel and moves later samples in that clip together; other clips keep their timeline positions. The inserted region becomes selected. This is useful for adding a lead-in, preserving a pause or leaving room for delay/reverb tails. Times round to whole audio samples. Undo restores the original in one step.

**Zero crossing…** beside the selection fields searches near each edge for a shared zero crossing across the selected channels. The default radius is 5 ms and the maximum is 50 ms. The nearest candidate wins; equal-distance candidates favor the earlier time. An edge with no shared crossing stays unchanged, and a selection never becomes empty. The tool inspects channels separately so opposite-polarity stereo cannot cancel into a false silent boundary. Choose one channel to use that channel’s crossings. This only adjusts the selection; short fades remain useful if an edit still clicks.

**Extract channels…** creates one speaker-labeled mono track for each channel of the whole selected clip, retaining the source and exact source placement. The new tracks start muted so the current mix does not double. Unmute a stem with its **M** button and use **Solo** to audition it. Stereo stems pan left/right; surround stems are centered for independent editing and preserve their FL/FR/FC/LFE/BL/BR/SL/SR labels. This operation does not copy source live effects or recreate native surround speaker routing. One Undo removes all extracted tracks. Admission checks ensure the expanded project remains within track, clip and portable PCM limits.

Shortcuts: **Ctrl/⌘ Shift I** inserts silence, **Shift Z** opens zero-crossing selection, and **Ctrl/⌘ Shift U** extracts channels.

### Audio presets: cleanup, vocals and mastering

Open **Audio presets** from the workbench. Use **Find a preset** and **Category** to filter the 36 recipes. Select a recipe to read its processing order, source requirements and limitations, then **Audition**, **A/B** and **Apply**. The selected region and channels define its scope; clearing the region processes the whole selected clip. Apply preserves duration and creates one undo entry.

| Category | Available recipes |
| --- | --- |
| Cleanup | Repair clipped peaks; Remove DC offset; Reduce low rumble; Soften high-frequency hiss; Gentle room-noise gate; Firm room-noise gate; Normalize peaks at −1, −3 or −6 dBFS. |
| Vocals | Vocal isolation · stereo center; Instrumental isolation · stereo sides; Vocal removal · center reduction; Instrumental removal · center focus; Gentle de-esser; Focused de-esser; Vocal presence. |
| Instruments | Bass definition; Drum punch; Acoustic clarity; Smooth piano. |
| Compression | Gentle bus compression; Vocal leveling compression; Punchy drum compression; Dense speech compression. |
| Limiting | Auto limiter; Transparent peak limiter; Fast peak limiter; Headroom limiter. |
| Mastering | Balanced mastering start; Warm mastering start; Clear mastering start; Louder mastering start. |
| Creative | Telephone voice; Warm tape color; Spacious chorus; Rhythmic pulse. |

The four vocal/instrumental center recipes require an original **stereo clip with both channels selected**. Vocal isolation extracts the shared center into both channels and focuses its frequency range. Instrumental isolation extracts stereo difference information: centered bass and drums can disappear along with vocals, and its opposite-polarity outputs **cancel when summed to mono**. Vocal removal reduces a band-limited center while retaining center bass and out-of-band highs. Instrumental removal focuses the 180 Hz–6.5 kHz center and normalizes it to −3 dBFS, reducing side-panned accompaniment while retaining centered instruments. These operations use stereo center/side math rather than AI source separation. They cannot guarantee isolated vocals or instruments; panned voices and stereo reverberation may remain.

**Repair clipped peaks** targets short, flat, near-full-scale plateaus with unclipped shoulders, up to 4 ms. Successful repair reserves −1 dBFS sample-peak headroom. Clean audio stays unchanged when no repair is made; long, edge or heavily distorted clipping cannot be reconstructed reliably. **De-essers** dynamically attenuate a high-frequency band, so audition bright instruments as well as speech.

**Normalize peaks** presets target −1, −3 or −6 dBFS using one gain for all selected channels. This preserves channel balance and dynamics; silence stays silent. Normalization raises quiet wanted material and noise together and measures sample peaks, not LUFS or intersample true peaks.

**Auto limiter** measures selected PCM RMS, adds at most 6 dB toward −18 dBFS RMS and limits sample peaks to −1 dBFS. It leaves silence and material below −60 dBFS RMS unboosted; the gain cap or peak ceiling can prevent reaching the RMS target. Mastering and compression presets provide fixed starting points for listening and adjustment. Their RMS/sample-peak targets do not certify integrated LUFS or intersample true-peak compliance. Use the individual tools or rack when you need editable processor parameters.

## 4. Build an ordered effects rack

Open **Shape the sound → Effects**. Add echo, delay, reverb, chorus, flanger, phaser, distortion, tremolo, filter, tape, stutter, bitcrusher or noise gate. A rack can contain up to twelve stages, including repeated instances of the same effect.

Audio flows from top to bottom. Drag a stage by its grip, use the up/down buttons, or focus the grip and use Up/Down/Home/End. The stable stage ID keeps its XY and automation references attached when reordered. Bypass retains settings while skipping that stage.

Every stage has its own wet/dry control. Zero percent passes the stage's incoming dry signal; one hundred percent uses its processed result. The next stage receives that blend. A wet/dry knob therefore belongs to an individual effect, not only to the full chain.

### Useful starting points

| Goal | Start with |
| --- | --- |
| Distinct fading repeats | Echo: time, repeat count and decay. |
| A sustained rhythmic repeat | Delay: time and feedback. |
| Room space | Reverb: room size, damping and pre-delay. |
| Motion or a pulse | Chorus, flanger, phaser or tremolo. |
| Frequency shaping | Low-pass, high-pass, band-pass or notch filter with cutoff and resonance. |
| Tape coloration | Drive, slow wow, faster flutter and warmth. |
| Short repeated fragments | Stutter: slices per beat, gate length and edge fade. |
| Digital texture | Bitcrusher: bit depth and sample hold. |
| Noise between phrases | Noise gate: threshold, hysteresis, closed level, attack, hold and release. |

For a stutter edit, select the passage to transform, add Stutter and set the tempo. The effect repeats the first beat-divided slice within that selected range. It does not move unrelated samples.

Echo/reverb/delay do not append hidden tails beyond a selection or export boundary. Include trailing silence in a source/range when a tail needs space.

### Signal-triggered noise gate

Choose **Noise gate** in the Effects rack, or press **E K** to add one. Set **Open threshold** just above the background noise, then audition the quiet and loud portions. **Close hysteresis** places the closing threshold below the opening threshold to avoid rapid chatter. **Hold** keeps the gate open through brief gaps. **Attack** and **Release** smooth the gain changes; they are one-pole time constants, and the effect has no lookahead. A fast attack preserves the start of a phrase; slower release preserves its fade.

**Closed level** controls attenuation when closed: −80 dB is very quiet; 0 dB leaves the signal unchanged. **Linked** detection uses the largest absolute sample across the selected channels and applies the same gain to all of them, preserving their balance. **Independent** gives each channel its own detector and envelope. A gate reduces noise between phrases; it does not remove noise underneath a louder voice or instrument.

The gate works in selection previews, undoable Apply, live racks, automation and explicit live rendering. Selection and live processing share the same envelope implementation and preserve clip duration. As with other effects, saved PCM includes the change after Apply, or after an explicit live-effects render.

### XY control

Choose a continuous parameter for X and a different one for Y. The two can belong to the same stage or different stages. Drag the pad, use its keyboard controls, or adjust the individual sliders. Removing a referenced stage clears the missing axis assignment. MIDI CC can control a parameter or either XY axis.

### Selection mode and Live mode

**Selection** previews and applies the rack to committed audio. **Live** edits the Master or a chosen track rack while transport continues. Knob changes use the audio clock; the app does not rebuild a full mix preview for every movement.

Ordinary committed source edits made while using Live mode affect the next playback snapshot. Existing playing buffers remain stable. Removing a track releases its voices; replacing a project stops owned input, capture, layers, notes and stale callbacks. Changing project output layout stops and rebuilds the audio graph for the new channel count while retaining rack definitions.

To print a live rack, choose **Render current live effects** in Export. The renderer uses a snapshot of the settings and automation with effect history initially empty at the requested start. To preserve the feedback/history of an already-running performance, capture the program with the long recorder instead.

## 5. Key detection, colors and live signal

**Detect key** analyzes the selected sample. **Sample keys** can analyze all samples and lets you override an uncertain estimate. Written tonic/mode labels and confidence accompany the colors; color alone is never the musical identifier.

Short, noisy, percussive or mixed-key material may be uncertain. Confidence is a heuristic, not a transcription guarantee. Major and minor labels remain distinct even when they share a tonic color. The waveform also uses color to reveal signal magnitude and frequency character, with theme-dependent contrast.

### Full-color live display

At the bottom of the workbench, **See what you hear** follows the active audio signal. **Waveform** is the initial view. Use **Display** to choose:

| Display | How to read it |
| --- | --- |
| Waveform | Separate colored channel traces show sample amplitude over milliseconds. Narrow peaks remain visible at the available screen resolution. |
| Waterfall | Logarithmic frequency runs left to right; height and color show spectral level, with older frames behind the newest frame. |
| Spectrogram | Time runs left to right, logarithmic frequency bottom to top, and color shows spectral level from −96 to 0 dB. |

Choose **Program output** for the program signal after live effects and before monitoring downmix, or **Active audio input** for an input you already started in Options. The visualizer never starts a microphone or transport by itself. Input can be inspected with monitoring off. Program metronome clicks are monitoring-only and are not part of this signal.

**Freeze** retains the current display while audio continues; **Resume** starts a fresh visual history. Reduced-motion preferences start animation paused. The panel suspends its analysis while hidden or outside the viewport, then starts a fresh history when it returns. Changing display mode does not change audio, rack settings or transport.

Frequency views combine channel power rather than summing signed samples, so opposite-polarity stereo remains visible. Frequency resolution is finite, and the history uses a bounded rolling window. The level readout is a sampled live observation; it is not a LUFS meter or a true-peak compliance measurement.

## 6. Save a session, a track, a mix or stems

Each track has **Save / Export** and a close button. Save/Export targets that exact clicked track even when another track is selected. Close removes the track and releases its live voice; Undo can restore the editable audio.

The export dialog makes scope and format separate choices:

| Scope or format | Result |
| --- | --- |
| Full project mix | A rendered audio mix using the chosen sound source and output settings. |
| One track | That track's rendered audio, or a genuine one-track editable session. |
| Selected clip | The chosen clip, including its committed edits. |
| Selected region | The selected time interval and chosen editing channels. |
| All tracks as a stem ZIP | Independently rendered track files with safe, unique names. |
| WebSoundEdit editable JSON | Tracks, clips, embedded float PCM, metadata, keys, source MIDI and saved editor/live definitions. |
| Audacity AUP3 / legacy ZIP | Supported editable Audacity content with explicit compatibility limits. |
| REAPER ZIP | A genuine RPP project and its referenced WAV media. |

Independent track/stem export includes gain/pan and ignores mute and other-track solo unless explicitly requested. The **Honor track mute** option changes that behavior. Align stems to project length when files need a common start and end for another DAW. With alignment disabled, each track keeps its own extent; starts still align to project zero.

**Raw / committed PCM without mix controls** bypasses gain/pan. It includes already-applied sample edits. **Committed audio + mix controls** is the normal rendered sound. **Render current live effects** additionally prints the current live rack and automation. Raw and live are separate choices.

Choose an explicit output layout to convert channel arrangement. Otherwise use the project render layout for mixed exports; raw source rendering preserves its source-channel behavior. Encoder support is checked against the actual shipped/runtime codec. WAV supports 16/24-bit PCM and 32-bit float. Float WAV preserves sample headroom that an integer file cannot represent without clipping.

### Audio file types

Import and export support **WAV, MP3, FLAC, Ogg Vorbis, Opus, M4A/AAC, raw AAC, AIFF, ALAC and WMA v2**, subject to the available decoder/encoder and its supported channel layouts. ALAC uses an M4A container, while Opus exports use 48 kHz. WAV encoding is built in; other encoders load on demand from the application's own files. Import tries browser decoding and the bundled fallback as appropriate, reading the actual contents rather than trusting a filename extension.

Changing a lossy file to FLAC or WAV does not restore lost detail. A large file can exceed the decoded-memory limit even when its compressed size is small. Batch audio uses the same codecs and checks, and can produce several formats per input with a script.

### Metadata

Open **Metadata** to edit supported text fields such as title, artist, album and comments. The session keeps those values; audio export embeds fields supported by the selected format and reports its format-specific limitations. Changing file tags does not alter waveform samples. Metadata is separate from a track's display name and the export filename.

## 7. Exchange projects with Audacity or REAPER

Native WebSoundEdit JSON preserves this editor's own settings most completely. Use it for round-tripping effect drafts, MIDI mappings, sample-key annotations and macro definitions. Armed triggers, active devices and connection credentials are never restored.

For Audacity, open a supported `.aup3`, an `.aup` with its supplied `_data` media, or a bundle ZIP. Export a genuine AUP3 or a legacy ZIP. Surround export defaults to rejection. Explicit **Split into labeled mono channel tracks** preserves speaker channel PCM and identity; it does not claim Audacity has a native 5.1/7.1 mixer.

For REAPER, use a project/media ZIP or supply one loose `.rpp` with its referenced local files. The importer uses only those supplied media aliases and reports missing/ambiguous references. It does not fetch a path or network URL embedded in a project. Export includes the referenced media in the ZIP.

Both formats have documented supported subsets. Unsupported plugins, envelopes, routing or project features are reported rather than represented as a lossless application clone. Read the [Audacity](AUDACITY.md) and [REAPER](REAPER.md) matrices and the current native verification evidence before relying on a particular exchange workflow.

## 8. MIDI controllers and pedals

Open **Options → MIDI & pedals** and choose **Connect MIDI**. Web MIDI permission is requested without SysEx. Pick the actual input/output ports. File-based MIDI import/export works separately from hardware support.

Incoming notes trigger the selected sample: note 60 uses original pitch, other notes transpose, and note-off releases the voice. The sampler uses the shared live master route. **Stop all notes** clears owned sample voices and sends all-notes-off to the selected MIDI output.

For a continuous control, add rack stages, choose a parameter or XY target, click **Learn next CC** and move the hardware knob. The mapping retains the MIDI channel and controller number. A deleted stage leaves its mapping inactive until remapped.

For a pedal or pad, choose CC/note, channel, controller/note number, press threshold, debounce and a registered command or saved macro. Supply that command's JSON arguments, add the definition and explicitly arm the actions locally. Rising-edge tracking is separate for each input device. Held/repeated values and releases do not repeatedly trigger an action. A useful command is `loop.capture.toggle` with the desired source, beat length and quantization.

Standard MIDI File import supports format 0/1 with PPQ timing and tempo maps, within the file/note/timeline bounds. It renders a simple sine instrument and retains note timing/velocity for MIDI export. That export does not transcribe later audio edits or reproduce an original soundfont/plugin. Unsupported SMPTE/format-2 timing and malformed unclosed notes are rejected. Ambiguous overlapping same-pitch note-off ordering is rejected rather than silently swapping durations.

## 9. Configure input, output and surround

**Audio input** can request a microphone/interface or a browser display-audio picker. Physical input channels use zero-based indices, for example `0, 1`. Start input is explicit; merely visiting Options reads available device names without starting capture.

To use a USB or built-in interface, connect it, open **Audio devices** or **Options → Audio input**, and choose **Rescan devices**. Select the input device and channel indices, then **Start input** and grant the browser's permission. Device names can remain hidden until permission is granted. Changing the chosen device or channels requires Start input again; **Apply gain / processing** updates supported controls on an active input. **Stop input** releases the acquired tracks.

Input monitoring starts off. Enable it deliberately when you want to hear the source through the selected output. Input gain and monitor gain are separate. Echo cancellation, noise suppression and automatic gain are requests that the browser/device may or may not honor. Their music-oriented default is off.

A display picker may not provide system/tab audio. In that case the app reports the missing capability and closes all acquired media tracks. Device removal, denied permission and unavailable output selection remain visible. Saved device IDs are preferences, not permission grants.

In **Audio output**, rescan and select an output, choose the monitoring layout, then **Apply output routing**. **Choose output device…** appears when the browser offers a permission-bearing output picker. If output selection is unavailable, use the operating system's default output selector. WebSoundEdit uses browser audio APIs and the operating-system audio route; it cannot take exclusive ASIO/WASAPI control, install drivers or change a sound card's hardware buffer settings.

The device panel distinguishes project, audio-engine and acquired-input sample rates. It also displays browser-reported processing/output latency estimates and reported capture processing. An absent value is shown as unreported; these values are not a measured input-to-output round trip. Available channels and routing must be checked on the actual device.

| Layout | Canonical channel order |
| --- | --- |
| Mono | M |
| Stereo | FL, FR |
| 5.1 | FL, FR, FC, LFE, BL, BR |
| 7.1 | FL, FR, FC, LFE, BL, BR, SL, SR |

Project layout, acquired input channels and actual output capability are distinct. Selecting 7.1 does not create extra speakers on a stereo device. The output section reports the destination's capability and fallback, and lets you select a monitoring layout/downmix. Stereo pan uses the front pair; the multichannel implementation preserves the other speaker channels. WAV uses explicit speaker metadata for surround interchange.

## 10. Capture live loop layers

Open **Live performance → Loop layers**. Choose **Input**, **Master program** or a specific track as the source. Input capture requires starting that input first. Set the beat count, tempo and Immediate/Next beat/Next bar boundary.

**Start capture** arms or begins the take. It ends at the requested sample-clock beat boundary, commits a new editable track and starts one loop voice. **Stop & keep take** commits completed audio early; **Cancel capture** discards the in-progress take.

Choose **Input** for guitar or microphone layering when the first repeat needs the most direct transition. Input and individual-track captures switch to repetition on the audio clock. **Master program** captures the whole mix and can have a brief delay before its first audible repeat while the capture connection changes; its repeat phase remains aligned. This handoff delay is separate from the input/output device's latency.

Each completed layer has independent Play, Stop, Mute and Delete controls. Runtime-owned loop tracks are omitted from ordinary transport playback so the same audio does not sound twice. Stop keeps a layer's track; Delete removes it. Transport Stop stops all loop voices. Panic stops owned notes and active capture.

The existing **Loop studio** remains useful for offline repetition of a selected fragment. Its crossfades overlap adjoining copies and shorten each join; zero crossfade preserves beat-exact repeated duration. Live capture and offline repetition have separate controls and purposes.

## 11. Record a long set and recover it

Open **Live performance → Long recorder**, choose input/master/track, give the take a name and optionally set byte or time limits. The recorder writes bounded PCM chunks to the browser's origin-private file storage (OPFS), separately from the waveform editor.

Start, Pause, Resume and Stop operate on the same take. A pause omits the elapsed wall-clock gap. The panel shows elapsed time, actual status, committed bytes, queued bytes and an estimated amount of space. A storage estimate is not a reservation.

Stop retains the archive. Quota/backpressure/device errors preserve the last committed range where possible and report a partial/error state. Open **Recording archive**, refresh its manifests and use **Recover interrupted recordings** when necessary. A take is erased only through its explicit delete confirmation; imported clips remain in the editable project.

Choose a nonempty range for audition or import as a new track. Resident audition/import is limited to ten minutes and 256 MiB. Stop the current take before reading its own archive. While recording is active, archive reads/exports are blocked so a long read cannot starve the bounded writer queue; pausing permits operations on other completed archives.

**Export full recording** streams WAV/RF64 to a chosen writable file when the browser supports the File System Access picker. This does not assemble an entire multi-hour recording in memory. Without that capability, bounded exports up to 64 MiB are available; choose a shorter range for larger archives. Browser storage remains tied to this browser/device/origin until exported.

The configured maximum recording limits are 24 hours and 512 GiB, also constrained by real storage availability, device behavior and throughput. These bounds are not a claim that every browser or device can sustain such a recording. Accelerated storage tests and browser capture tests are reported separately from physical-duration/hardware testing.

## 12. Automate, repeat and batch

Use **Macros → Record actions** to capture successful editing commands, then edit the same canonical text in Script or Visual steps. Visual mode supports simple command sequences; scripts with loops and conditions remain intact in Script mode.

### Scripts, randomization and results

**Macros → Edit & run** provides six editable examples: normalize a batch to WAV; make WAV/FLAC/MP3 copies; export six repeatable sample variations; build a seeded nested-loop sound bank; measure/clean/normalize conditionally; and explore arrays, shuffle and nested iteration. Loading an example changes the draft; read its description before running an example that creates a project or edits audio.

The language supports `let`, reassignment, arithmetic, conditions, arrays/objects, nested `repeat`, `while` and `for…of`, plus `break` and `continue`. Its **35 built-in tools** provide random numbers and choices, array construction/copying/sorting/shuffling, math and text conversion. Every call accepts an argument object. Array helpers return copies, so assign the result to retain a change. The **Random, arrays & math** reference lists signatures.

```js
random.seed({seed: "my-variations"});
let rows = [];
for (gain of [-9, -6, -3]) {
  let row = [];
  repeat (2) {
    row = array.append({values: row, value: {
      gainDb: gain, variation: random.int({min: 1, max: 8})
    }});
  }
  rows = array.append({values: rows, value: row});
}
```

An explicit seed makes the run repeatable. `random.float` excludes its upper bound; `random.int` includes both endpoints. A batch executes each input separately, so a fixed seed gives every file the same sequence; seed from `input.stem` for repeatable filename-based variation. This random generator is for creative work, not cryptographic keys.

After a normal run, expand **Run result and variables** or use **Download result JSON**. A long on-screen preview is explicitly shortened; the download contains the full retained result. Loops share one bounded operation/iteration budget and yield so Stop can be handled between operations. A stopped ordinary macro retains completed edits for Undo.

**Record timing** preserves pauses with waits. **Live performance → Automation** sets time/value points on a specific stage parameter for a repeatable audio-clock sweep. Select the target, stage and parameter, enter step/linear points and use **Set lane**. Clearing target automation affects that chosen rack.

### Quick batch conversion

Open **Batch audio** or **Macros → Batch files** and select **Convert audio / apply a preset**. Choose one of the ten audio formats, an optional preset and optional −1 dBFS sample-peak normalization, then supply files and run. **View the generated script** shows the commands. The recipe exports raw clip PCM, preserving source channels without mix panning, at the current project's sample rate; codec layout limits still apply. A script can instead loop over formats and export several versions per input.

**Batch files** gives each supplied input a cleared editor, reports per-file progress/errors and restores the original browser session once after completion or cancellation. Outputs remain bounded; split larger batches or use the local CLI. A locally armed after-import macro can trim, normalize, convert and export manually imported audio. Importing project/settings/script definitions never arms it, and macro/batch imports do not recursively invoke it.

The draft is retained while the batch runs. Choose whether to continue after a file error, inspect the per-file results, and download completed files individually or as a collected ZIP. Cancellation retains completed outputs and restores the original project. Up to 128 supplied aliases, 256 MiB input bytes and 128 MiB collected exports remain subject to the separate decoded-audio limits.

While a browser batch runs, a banner explains that it owns the session. Editing, MIDI controls and outside imports or exports are paused until the original project has been restored; API callers receive `BUSY` for those operations. You can browse help, inspect progress or close the macro view and use **Stop batch** in the editor. Let any earlier file operation finish before starting a batch. Ordinary **Run** macros keep the editor interactive for performance use. Batch scripts use the actual effect, project and file commands instead of UI action wrappers.

The [scripting and batch guide](SCRIPTING.md) contains the complete data-tool reference, nested-loop examples, seed behavior and execution bounds. The [macro guide](MACROS.md) adds action recording, automation, triggers and loop-layer workflows. The same operations are discoverable through `websoundedit.commandCatalog()` and canonical `websoundedit.execute(method, params)` calls.

## 13. Stream through the local companion

GitHub Pages cannot open raw UDP sockets. The optional local companion owns networking and advertises destinations configured by its operator. Start the companion separately, then explicitly connect through **Options → Streaming companion** with its current loopback endpoint and per-run token.

The token stays in memory and is cleared from the form after connection. Browser local-network permission may be required. Choose only an advertised destination and profile. Available encoded profiles depend on installed native encoders. Start the live input first: streaming does not silently acquire a microphone or open a display picker.

Start/Stop/status use the same `stream.*` commands as macros and the API. A macro chooses a destination name and encoding profile; it cannot introduce an arbitrary URL, shell command or FFmpeg argument string. The status shows the actual format and bounded queue/counter information. Project replacement, disconnection or owned-stream teardown stops that active broadcast.

The optional local HTTP API is a separate runtime from an already-open Pages tab. Both use the same engine; loading a portable project moves session content between them. There is no public REST audio server at the Pages URL.

## 14. Recovery, limits and verification

Browser recovery is a convenience for the current device. Save portable session JSON and export archive recordings when you need an independent copy. **Clear recovery** deliberately removes the browser's editor-recovery record; it does not stand in for deleting a recording archive.

Clear recovery cancels unfinished snapshots and waits for any older save already being written in this editor. Once it finishes, that older save cannot recreate the cleared copy. Editing again can create a new recovery copy normally.

| Area | Principal bound or dependency |
| --- | --- |
| Editable project/render | Ten minutes and 256 MiB decoded PCM |
| Arrangement | 64 tracks, 512 clips |
| Offline rack | Twelve stages per rack |
| Live processing | 65 graphs, 128 total stages, 128 shared active voices, 64 MiB DSP state/scratch, 8,192 queued automation events |
| Macro/batch | Bounded interpreter, 128 input aliases and 128 MiB output collection; see the macro guide |
| Long recording | OPFS and AudioWorklet; bounded write queues and actual storage quota |
| Hardware MIDI | Browser Web MIDI support and explicit permission |
| Input/output selection | Browser/device support; actual available ports/channels may differ from preferences |
| Non-WAV conversion | An available shipped browser encoder or installed native encoder in the companion |

Errors preserve actual state and explain unsupported operations. A theme, layout selector or command descriptor does not prove a particular hardware capability. The [verification record](VERIFICATION.md) identifies actual unit, browser, native-DAW and deployment evidence, including pending checks and limitations.
