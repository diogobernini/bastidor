<p align="center">
  <img src="docs/icon.png" width="110" alt="Bastidor icon" />
</p>

<h1 align="center">Bastidor</h1>

<p align="center">
  An open source embroidery studio for Windows and macOS: view, convert, simulate and
  adjust embroidery designs. Built around <strong>Singer XXX</strong>, with DST, PES, PEC, JEF and EXP support.
</p>

<p align="center">
  <a href="README.pt-BR.md">Leia em português 🇧🇷</a>
</p>

<p align="center">
  <img src="docs/en/main.png" alt="Bastidor with a Singer XXX design open" width="900" />
</p>

## Why

Commercial embroidery software is expensive, dongle-locked or stuck in the past.
Bastidor is an open, lightweight and modern alternative for everyday design work:
open, inspect, convert between formats, simulate the needle path and apply the right
machine adjustments when saving.

The app is bilingual (English and Brazilian Portuguese) and follows your system language.

## Features

- **Canvas viewer** with zoom, pan, millimeter grid and configurable hoop
- **Stitch-by-stitch simulator**: plays back the needle path with adjustable speed and a scrubber
- **Design details**: dimensions, stitches, color changes, jumps, trims, average/longest stitch and density
- **Per-block color editing** (written to formats that store colors, like XXX), with live preview while picking and merging of adjacent blocks (one fewer thread stop, stitch sequence untouched)
- **Transforms**: center, rotate 90°, mirror and resize, with undo
- **Object canvas**: select, move, resize and delete design elements like a vector editor; lettering, SVG and digitized objects are parametric, so a proportional resize re-runs the real generator at the configured density instead of stretching stitches
- **Native project file (.bastidor)**: keeps objects editable across save and reopen · machine formats stay flat exports
- **Format conversion** with saving adjustments:
  - automatic splitting of long stitches, always respecting each format's limit
  - configurable maximum stitch length (tightens beyond the format limit)
  - automatic lock stitches (tie-on and tie-off)
  - trim after N consecutive jumps (DST)
- **SVG and PNG export** for client approval
- **Warnings**: stitches too long and designs larger than the hoop
- Drag and drop, recent files, keyboard shortcuts

## Formats

| Format | Machines | Read | Write |
|---|---|:---:|:---:|
| XXX | Singer Futura / Compucon | ✓ | ✓ |
| DST | Tajima and most industrial machines | ✓ | ✓ |
| EXP | Melco / Bernina | ✓ | ✓ |
| PES / PEC | Brother / Babylock | ✓ | ✓ |
| JEF | Janome / Elna | ✓ | ✓ |
| VP3 | Husqvarna Viking / Pfaff | ✓ | ✓ |
| HUS / SEW | Husqvarna Viking · Janome/Elna (older) | ✓ | – |
| PCS | Pfaff | ✓ | ✓ |
| SVG / PNG | vector and image (digitized into stitches on import) | ✓ | ✓ |
| BASTIDOR | native project: objects, parameters and stitches (parametric editing survives reopen) | ✓ | ✓ |

The parsers are cross-validated against [pystitch](https://github.com/inkstitch/pystitch):
files written by Bastidor are read back by the reference library with identical geometry
and colors, and vice versa (see `tests/`).

## More screens

| Settings (saving adjustments, hoop, grid) | Welcome |
|---|---|
| ![Settings](docs/en/settings.png) | ![Welcome screen](docs/en/welcome.png) |

| Library (browse designs, search, thumbnails) |
|---|
| ![Library](docs/en/library.png) |

## Running

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Sample designs live in `samples/` (the rosette from this page, in every format).

```bash
npm test         # format round-trip test suite
npm run samples  # regenerates the sample designs
```

## Packaging (installers)

```bash
npm run dist:mac   # .dmg and .zip
npm run dist:win   # NSIS installer and portable
npm run dist       # both
```

Installers land in `dist/` with file associations (.xxx, .dst, .pes, .pec, .jef, .exp).

## Architecture

```
src/
  core/            # pure Node core, no Electron (testable in isolation)
    pattern.js     # design model (stitches, threads, transforms)
    encoder.js     # save-time normalizer (long stitches, lock stitches, trims)
    palettes.js    # factory thread charts: Brother (PEC) and Janome (JEF)
    io/            # one module per format + central registry
  main/            # Electron main process (window, menu, IPC, preferences)
  renderer/        # UI (canvas, simulator, panels)
  i18n.js          # English / Portuguese strings
```

Internal unit: 0.1 mm (the industry standard). The `core` has no Electron
dependency, so the parsers can be reused in a CLI or server.

## Roadmap

1. ✅ Digitizing: import SVG vector files as stitches
2. ✅ Digitizing: PNG to vector tool (posterize by color count, with preview)
3. ✅ Lettering tool: type text as embroidery (single-line fonts, satin, TTF and Ink/Stitch fonts)
4. ✅ Individual stitch editing (move, delete, insert)
5. ✅ Density recalculation when resizing
6. ✅ Realistic thread rendering (thread texture)
7. ✅ VP3, HUS, SEW and PCS support
8. ✅ USB drive manager: library-style load and unload of designs, with safe eject and macOS hidden-file cleanup
9. ✅ Library manager: browse the design catalog by folder, with search, thumbnails and open/save-as integration ([issue #17](https://github.com/diogobernini/bastidor/issues/17))

### Phase 2

1. **Object canvas** ([#29](https://github.com/diogobernini/bastidor/issues/29)): ✅ phases 1-2 — select, move, resize and delete like a vector editor, parametric objects with real stitch regeneration, minimum-spacing guard and the native `.bastidor` project file. Phase 3 open: rotation, multi-select, align/distribute, stitch order, duplicate
2. ✅ Reliability and distribution: CI on every PR ([#30](https://github.com/diogobernini/bastidor/issues/30)), signing/notarization/installers/auto-update ([#31](https://github.com/diogobernini/bastidor/issues/31)) · pending: validation on a physical machine ([#32](https://github.com/diogobernini/bastidor/issues/32))
3. ✅ Foundation: renderer modularization ([#33](https://github.com/diogobernini/bastidor/issues/33)), Electron UI test suite ([#34](https://github.com/diogobernini/bastidor/issues/34)), 10-15k-design library scale ([#35](https://github.com/diogobernini/bastidor/issues/35), [#28](https://github.com/diogobernini/bastidor/issues/28)), delta undo ([#37](https://github.com/diogobernini/bastidor/issues/37))
4. ✅ Polish: docs refresh ([#36](https://github.com/diogobernini/bastidor/issues/36)), shortcuts help and accessibility ([#38](https://github.com/diogobernini/bastidor/issues/38))

## Credits and thanks

The heart of this project, the knowledge of binary embroidery formats, exists thanks
to the generous open source work of others:

- **[pystitch](https://github.com/inkstitch/pystitch)**, maintained by the
  **[Ink/Stitch](https://inkstitch.org)** team: the reference library the Bastidor
  parsers were ported from (to JavaScript), and validated against.
- **[pyembroidery](https://github.com/EmbroidePy/pyembroidery)**, by **Tatarize**
  and contributors (EmbroidePy): the original project that documented and implemented
  these formats, and the foundation of pystitch.

Thank you! The original MIT license is preserved in
[`LICENSES/pystitch-LICENSE.txt`](LICENSES/pystitch-LICENSE.txt).

### Bundled fonts

Bastidor ships with single-line lettering fonts under the SIL Open Font License and related free licenses:

- **Hershey Sans 1-stroke**: Hershey Fonts license (permissive with attribution)
- **EMS Nixish** and **EMS Allure**: SIL Open Font License 1.1
- **Pacifico Regular**: SIL Open Font License 1.1
- **Allegria Sample** (Ink/Stitch fonts collection): SIL Open Font License 1.1

See [`fonts/README.md`](fonts/README.md) for detailed credits and license files.

## License

[MIT](LICENSE) © Diogo Bernini
