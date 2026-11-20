# Third-party components

- **@soundtouchjs/core 2.1.1** — MPL-2.0. Source and license: https://github.com/cutterbl/SoundTouchJS/tree/master/packages/core . Audio tempo processing uses its WSOLA implementation. The adapter is derived from Circuit Drift Labs WebMicrophone. Source for this integration is in this repository.
- **@ffmpeg/ffmpeg 0.12.15** — MIT wrapper. https://github.com/ffmpegwasm/ffmpeg.wasm . Browser worker wrapper license included alongside this file.
- **@ffmpeg/core 0.12.10** — FFmpeg.wasm core, distributed under GPL-2.0-or-later as configured by upstream with external codec libraries. Corresponding source, build scripts and external library version/source links: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10 and https://github.com/ffmpegwasm/ffmpeg.wasm/tree/main/build . This repository uses the unmodified npm core binary. See upstream Dockerfile/build source for all linked codec licenses. The single-thread core is loaded only for formats requiring conversion. FFmpeg: https://ffmpeg.org/legal.html ; LAME: https://lame.sourceforge.io/ ; Opus: https://opus-codec.org/ ; Vorbis: https://xiph.org/vorbis/ ; FLAC: https://xiph.org/flac/ .
- **libopus-wasm 0.3.0** — MIT JavaScript wrapper with embedded BSD-licensed libopus 1.6.1. Source: https://github.com/openclaw/libopus-wasm ; underlying codec: https://github.com/xiph/opus . The dedicated Opus encoder runs in a same-origin worker at full complexity; this project supplies the Ogg container writer using RFC 7845. Wrapper license, package notices and upstream Opus copyright notice are included in the built licenses folder. This path avoids the stack-size defect in the older FFmpeg WASM libopus encoder (https://github.com/ffmpegwasm/ffmpeg.wasm/pull/824).
- **Vite** — MIT development/build tooling. https://github.com/vitejs/vite
- **Playwright** — Apache-2.0 testing tooling. https://github.com/microsoft/playwright
- **sql.js 1.16.0** — MIT SQLite WASM wrapper. https://github.com/sql-js/sql.js . Used only for local Audacity AUP3 database import/export. WASM binaries are self-hosted with the application; SQLite itself is public domain.
- **fflate 0.8.3** — MIT. https://github.com/101arrowz/fflate . Packages legacy Audacity XML and AU blocks into ZIP; input paths and declared decompressed sizes are checked before extraction.
- **@xmldom/xmldom 0.9.12** — MIT. https://github.com/xmldom/xmldom . Parses legacy Audacity XML without loading external resources. Internal DTD/entity declarations are rejected by this integration.

Audacity project interoperability is an original implementation of public file layouts, informed by the upstream source and documentation. No Audacity implementation code or native binaries are distributed in this application. See [Audacity compatibility](../docs/AUDACITY.md) for primary references and support boundaries.

No fonts, analytics, sample libraries, or media are loaded from external CDNs. Demo audio is synthesized locally by this project. CDL mark and palette originate from https://github.com/djshellshoxxx/circuitdriftlabs . The Circuit Drift Labs identity remains the owner's brand.

For exact installed component licenses and versions consult package-lock.json and node_modules packages. Dependency notices do not imply that every format is supported by every browser; the app checks the shipped encoder build.
