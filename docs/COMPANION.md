# Local companion, API and UDP streaming

The Pages application edits audio in the browser. Raw UDP output runs in the optional local companion because the browser's ordinary web APIs do not expose a UDP socket. The companion accepts an explicitly acquired live input from the tab and encodes it for a named destination configured by the operator. It does not acquire a microphone, scan devices or choose a receiver on its own.

## Start the companion

Install Node 22.12 or newer, obtain the matching source release, and run `npm ci` in that directory. Native FFmpeg on `PATH` supplies compressed encoders and resampling. Same-rate raw PCM and WAV editing work without FFmpeg.

Create a local `udp-destinations.json` file:

```json
[
  {"id":"studio","label":"Studio receiver","address":"127.0.0.1","port":5004}
]
```

Use the actual receiver's literal IP address if it is another machine. At most 16 distinct destinations are allowed; IDs are safe names, ports are 1–65535, and DNS names, URLs and shell arguments are rejected. The browser sees labels/IDs, not an arbitrary destination field. Destination configuration is read only at startup.

```sh
node scripts/server.mjs --port 8787 --allow-origin https://djshellshoxxx.github.io --destinations udp-destinations.json
```

The process prints its loopback URL and a newly generated Bearer token. In the editor, open **Options → Streaming**, enter that URL and token, and press **Connect**. The token stays in memory and is cleared on disconnect; it is excluded from project files, local preferences, recorded scripts and UI state exports. A browser may request local-network access. Use the exact origin shown above, without the `/websoundedit/` path, for the published site.

Start the microphone/instrument or shared-system input explicitly, then choose the advertised destination, format, sample rate, layout and bitrate. Press **Start broadcast**. Source rate/layout come from the actual acquired audio context. Stop the broadcast before changing input format; stopping input also stops its subscription. **Disconnect** stops owned streaming and clears the connection. Closing the companion reaps its encoder and socket. If the browser vanishes, the stream stops after 15 seconds without input.

## Available profiles

| Profile ID | Datagram payload | Supported layouts | Encoder |
| --- | --- | --- | --- |
| `s16le` | Raw signed 16-bit little-endian PCM | Mono, stereo, 5.1, 7.1 | No FFmpeg for same-rate output |
| `f32le` | Raw 32-bit little-endian floating PCM | Mono, stereo, 5.1, 7.1 | No FFmpeg for same-rate output |
| `opus` | Ogg/Opus byte stream | Mono, stereo, 5.1, 7.1 | Native `libopus` |
| `mp3` | MP3 elementary byte stream | Mono or stereo | Native `libmp3lame` |
| `aac-ts` | AAC in MPEG transport stream | Mono, stereo, 5.1, 7.1 | Native AAC |
| `flac` | FLAC byte stream | Mono, stereo, 5.1, 7.1 | Native FLAC |

Only encoders detected on that machine are offered. Profiles have explicit supported rate lists; these are returned by capabilities and shown in Options. Conversion uses canonical speaker matrices; stereo/mono downmix excludes LFE. Raw s16 clips to its numeric range. Raw float preserves finite working amplitudes. These are typed, implemented profiles; arbitrary codec commands or URLs are not supported.

A local raw PCM receiver example, matching mono 48 kHz output:

```sh
ffplay -f f32le -ar 48000 -ac 1 'udp://127.0.0.1:5004'
```

For stereo s16le, use `-f s16le -ar 48000 -ac 2`. A compressed receiver must understand the selected container. The Opus/Ogg and FLAC stream headers are sent when the stream starts, so start the receiver first. This transport is ordinary unencrypted UDP, has no delivery acknowledgments or automatic retransmission, and is not RTP. Packet loss can interrupt a compressed stream. The UI exposes sequence gaps, discontinuities, queued chunks, dropped frames and datagrams so failure is observable.

## Macros and API

Connect the companion and acquire the input through local user actions first. Then a browser macro can control the connection's stream:

```js
stream.start({destination: "studio", profile: "opus", sampleRate: 48000, layout: "stereo", bitrate: 192});
wait({seconds: 10});
stream.stop({});
```

The browser adapter supplies `inputSampleRate` and `inputLayout`. Direct Node/HTTP `stream.start` calls must include both because the caller supplies raw PCM. `stream.stop` accepts an optional stream ID in the Node API; a stale ID cannot stop a different owned stream. Server status reports inactive during incomplete startup. Cancellation, disconnect and stop invalidate pending startup, including encoder discovery and socket connection.

`POST /v1/stream/:id/pcm` takes `application/octet-stream` bytes in **interleaved f32le** format. Query fields are `sequence`, `startFrame`, `frames`, and optional `droppedFrames`. Packet bytes must exactly equal `frames × input channel count × 4`. Packets have increasing sequence numbers; gaps are counted. Samples must be finite and within ±1,000,000. An invalid packet is rejected before stream counters or output change. Formats, order and rates must match the start contract; the receiver is not responsible for guessing them.

## Resource and connection limits

The browser sends at most four queued 1,024-frame chunks. The API accepts at most 256 KiB per PCM request. The companion caps encoder stdin at 2 MiB and the UDP queue at 128 packets of at most 1,316 bytes, plus one small remainder. It drops rather than growing memory without bounds and reports loss. Stop gives the encoder and UDP queue bounded flush windows; forced or nonzero encoder exits remain visible as errors. One companion owns one active stream.

The HTTP service binds `127.0.0.1`, checks exact Host and allowed Origin, requires a Bearer token and does not use cookie authentication. CORS is only granted to the configured origin; preflight support does not grant authentication. Browser redirects are rejected, credentials are omitted, response bodies are capped, and connection tokens never appear in a request URL. Ordinary editing has a separate admission/byte budget; cancellation remains available when that queue is full.

## Troubleshooting

- **Connection denied:** confirm the process is running, its port/token match, the configured origin matches the tab, and the browser allowed local-network access. Regenerating the token requires reconnecting.
- **No destinations:** restart the companion with the destination configuration file. UDP is disabled without it.
- **Missing encoder/profile:** install a native FFmpeg build containing that encoder and restart the companion. `node scripts/cli.mjs --capabilities` reports installed support.
- **No input:** start and select the input before broadcasting. System-audio availability depends on the browser's screen/tab sharing picker.
- **Drops or discontinuities:** lower the channel count/rate, reduce local processing load, and check the receiver/network. Stopping and restarting establishes a fresh compressed stream header.
- **Macro stopped after completed edits:** completed commands remain applied; inspect the reported command and source location before rerunning. Undo can restore resident edits, while network output and external file writes are not undoable.

Protocol references: [FFmpeg UDP documentation](https://ffmpeg.org/ffmpeg-protocols.html#udp), [Chromium local-network access](https://developer.chrome.com/blog/local-network-access/), [API guide](API.md), [Macro guide](MACROS.md).
