# WebSoundEdit 1.0 beta user guide

WebSoundEdit combines sample editing, multitrack arrangement and live performance in one browser workbench. The waveform editor contains a bounded editable session. Long recordings use a separate disk archive. Native project saves preserve the editable session; rendered audio exports contain the sound you choose to print.

[Open WebSoundEdit](https://djshellshoxxx.github.io/websoundedit/) · [Macro guide](MACROS.md) · [API reference](API.md) · [Audacity compatibility](AUDACITY.md) · [REAPER compatibility](REAPER.md) · [Verification](VERIFICATION.md)

## 1. Find your way around

The center of the workbench is the arrangement: track controls on the left, colorful clip waveforms on the right, with transport, selection and zoom nearby. **Shape the sound** contains selection tools and the creative Effects rack. **Hide sound tools** collapses the whole inspector so the waveform has more room.

**Options** is an addressable view within the same app. Opening `#options/general`, changing sections or returning with Back/Close keeps the project alive. Help uses stable chapter routes such as `#help/effects` and `#help/macros`. **Macros** and **Live performance** have their own views.

Hover or focus a control for usage guidance. Effect tips explain the parameter, units/range and how the selected mode applies it. Press Escape to dismiss a visible tip. Turn **Show guidance on hover and keyboard focus** off in Options to disable tips globally; labels and the guide remain available.

Use **Ctrl K** to search workbench actions. On macOS, Command substitutes for Control. Keyboard shortcuts can be edited in Options. Save settings JSON for a portable copy of preferences and definitions.

### Main Options sections

| Section | What it controls |
| --- | --- |
| General & theme | Studio, Daylight, Midnight and Terminal themes; guidance preference; settings import/export. |
| Audio input | Microphone/interface or display-audio source, device, physical channel indices, gain and processing requests. |
| Audio output | Actual monitoring output device and monitoring layout, distinct from the rendered project layout. |
| Channel layout | Project render layout and explicit canonical speaker order. |
| MIDI & pedals | Device ports, sample note triggers, continuous CC mappings and locally armed command/macro actions. |
| Keyboard shortcuts | Reassign workbench actions without duplicating bindings. |
| Macros & import triggers | Links to recorded/script workflows and local trigger configuration. |
| Recording & storage | Archive capability, usage and available-space estimates. |
| Streaming companion | Explicit local connection, named destination, advertised encoding profile and real status. |
| Help & recovery | Linked guidance and an explicit recovery-clear action. |

The quick theme selector and Options theme choice stay synchronized. Device IDs and requested preferences may be saved, but a saved file does not grant permissions, start input/recording, reconnect a companion or arm triggers.

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

## 4. Build an ordered effects rack

Open **Shape the sound → Effects**. Add echo, delay, reverb, chorus, flanger, phaser, distortion, tremolo, filter, tape, stutter or bitcrusher. A rack can contain up to twelve stages, including repeated instances of the same effect.

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

For a stutter edit, select the passage to transform, add Stutter and set the tempo. The effect repeats the first beat-divided slice within that selected range. It does not move unrelated samples.

Echo/reverb/delay do not append hidden tails beyond a selection or export boundary. Include trailing silence in a source/range when a tail needs space.

### XY control

Choose a continuous parameter for X and a different one for Y. The two can belong to the same stage or different stages. Drag the pad, use its keyboard controls, or adjust the individual sliders. Removing a referenced stage clears the missing axis assignment. MIDI CC can control a parameter or either XY axis.

### Selection mode and Live mode

**Selection** previews and applies the rack to committed audio. **Live** edits the Master or a chosen track rack while transport continues. Knob changes use the audio clock; the app does not rebuild a full mix preview for every movement.

Ordinary committed source edits made while using Live mode affect the next playback snapshot. Existing playing buffers remain stable. Removing a track releases its voices; replacing a project stops owned input, capture, layers, notes and stale callbacks. Changing project output layout stops and rebuilds the audio graph for the new channel count while retaining rack definitions.

To print a live rack, choose **Render current live effects** in Export. The renderer uses a snapshot of the settings and automation with effect history initially empty at the requested start. To preserve the feedback/history of an already-running performance, capture the program with the long recorder instead.

## 5. Key detection and waveform colors

**Detect key** analyzes the selected sample. **Sample keys** can analyze all samples and lets you override an uncertain estimate. Written tonic/mode labels and confidence accompany the colors; color alone is never the musical identifier.

Short, noisy, percussive or mixed-key material may be uncertain. Confidence is a heuristic, not a transcription guarantee. Major and minor labels remain distinct even when they share a tonic color. The waveform also uses color to reveal signal magnitude and frequency character, with theme-dependent contrast.

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

Input monitoring starts off. Enable it deliberately when you want to hear the source through the selected output. Input gain and monitor gain are separate. Echo cancellation, noise suppression and automatic gain are requests that the browser/device may or may not honor. Their music-oriented default is off.

A display picker may not provide system/tab audio. In that case the app reports the missing capability and closes all acquired media tracks. Device removal, denied permission and unavailable output selection remain visible. Saved device IDs are preferences, not permission grants.

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

**Record timing** preserves pauses with waits. **Live performance → Automation** sets time/value points on a specific stage parameter for a repeatable audio-clock sweep. Select the target, stage and parameter, enter step/linear points and use **Set lane**. Clearing target automation affects that chosen rack.

**Batch files** gives each supplied input a cleared editor, reports per-file progress/errors and restores the original browser session once after completion or cancellation. Outputs remain bounded; split larger batches or use the local CLI. A locally armed after-import macro can trim, normalize, convert and export manually imported audio. Importing project/settings/script definitions never arms it, and macro/batch imports do not recursively invoke it.

While a browser batch runs, a banner explains that it owns the session. Editing, MIDI controls and outside imports or exports are paused until the original project has been restored; API callers receive `BUSY` for those operations. You can browse help, inspect progress or close the macro view and use **Stop batch** in the editor. Let any earlier file operation finish before starting a batch. Ordinary **Run** macros keep the editor interactive for performance use. Batch scripts use the actual effect, project and file commands instead of UI action wrappers.

The [macro guide](MACROS.md) includes validated cleanup, conversion, automation and loop-layer scripts, plus language and cancellation details. The same operations are discoverable through `websoundedit.commandCatalog()` and canonical `websoundedit.execute(method, params)` calls.

## 13. Stream through the local companion

GitHub Pages cannot open raw UDP sockets. The optional local companion owns networking and advertises destinations configured by its operator. Start the companion separately, then explicitly connect through **Options → Streaming companion** with its current loopback endpoint and per-run token.

The token stays in memory and is cleared from the form after connection. Browser local-network permission may be required. Choose only an advertised destination and profile. Available encoded profiles depend on installed native encoders. Start the live input first: streaming does not silently acquire a microphone or open a display picker.

Start/Stop/status use the same `stream.*` commands as macros and the API. A macro chooses a destination name and encoding profile; it cannot introduce an arbitrary URL, shell command or FFmpeg argument string. The status shows the actual format and bounded queue/counter information. Project replacement, disconnection or owned-stream teardown stops that active broadcast.

The optional local HTTP API is a separate runtime from an already-open Pages tab. Both use the same engine; loading a portable project moves session content between them. There is no public REST audio server at the Pages URL.

## 14. Recovery, limits and verification

Browser recovery is a convenience for the current device. Save portable session JSON and export archive recordings when you need an independent copy. **Clear recovery** deliberately removes the browser's editor-recovery record; it does not stand in for deleting a recording archive.

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
