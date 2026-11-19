# Third-party components

- **@soundtouchjs/core 2.1.1** — MPL-2.0. Source and license: https://github.com/cutterbl/SoundTouchJS/tree/master/packages/core . Audio tempo processing uses its WSOLA implementation. The adapter is derived from Circuit Drift Labs WebMicrophone. Source for this integration is in this repository.
- **@ffmpeg/ffmpeg 0.12.15** — MIT wrapper. https://github.com/ffmpegwasm/ffmpeg.wasm . Browser worker wrapper license included alongside this file.
- **@ffmpeg/core 0.12.10** — FFmpeg.wasm core, distributed under GPL-2.0-or-later as configured by upstream with external codec libraries. Corresponding source, build scripts and external library version/source links: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10 and https://github.com/ffmpegwasm/ffmpeg.wasm/tree/main/build . This repository uses the unmodified npm core binary. See upstream Dockerfile/build source for all linked codec licenses. The single-thread core is loaded only for formats requiring conversion. FFmpeg: https://ffmpeg.org/legal.html ; LAME: https://lame.sourceforge.io/ ; Opus: https://opus-codec.org/ ; Vorbis: https://xiph.org/vorbis/ ; FLAC: https://xiph.org/flac/ .
- **Vite** — MIT development/build tooling. https://github.com/vitejs/vite
- **Playwright** — Apache-2.0 testing tooling. https://github.com/microsoft/playwright

No fonts, analytics, sample libraries, or media are loaded from external CDNs. Demo audio is synthesized locally by this project. CDL mark and palette originate from https://github.com/djshellshoxxx/circuitdriftlabs . The Circuit Drift Labs identity remains the owner's brand.

For exact installed component licenses and versions consult package-lock.json and node_modules packages. Dependency notices do not imply that every format is supported by every browser; the app checks the shipped encoder build.
