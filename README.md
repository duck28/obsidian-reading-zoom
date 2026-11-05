# Reading Zoom

An [Obsidian](https://obsidian.md) plugin that adds pinch-to-zoom to notes on touchscreens (Windows, iPad, Android), in reading view and in editing view. It also supports trackpad pinch and Ctrl+scroll.

## Features

- **Pinch to zoom** around your fingers. Moving both fingers pans.
- **Reading view** has two modes:
  - **Reflow** (default): text and images grow and rewrap to the pane width, like browser zoom.
  - **Magnify**: the page grows wider with the zoom and you pan sideways, like a PDF.
- **Editing view** (Live Preview and Source mode): text and images grow and rewrap. Can be turned off.
- **Two-finger tap** resets to 100 %.
- **Commands**: Zoom in, Zoom out, Reset zoom (bind them to hotkeys).
- **Per pane**: each pane keeps its own zoom, optionally reset when another note opens.
- Shows the zoom percentage while zooming.

## Installation

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [release](../../releases), or build them (see below).
2. Copy them into `<vault>/.obsidian/plugins/reading-zoom/`.
3. In Obsidian, open **Settings → Community plugins**, reload the list, and enable **Reading Zoom**.

### From source

```bash
npm install
npm run build
npm run install-plugin -- "/path/to/Vault"
```

`npm run dev` rebuilds on every change.

## How it works

- **Text** is scaled through Obsidian's `--font-preferred-size` variable, and the readable line width through `--file-line-width`.
- **Images and videos** get a per-element CSS `zoom`. The plugin never applies CSS `zoom` to a container, because Obsidian and CodeMirror measure content inside it in unzoomed units, which breaks their lazy rendering.
- **Reading view lazy rendering:** Obsidian renders only the sections near the viewport and positions them from cached heights. It re-measures them only when the pane width changes. While a note is zoomed, the plugin keeps the whole note attached so scrolling is plain document flow. After each gesture it has Obsidian re-measure the note. Notes longer than 1,500 sections keep lazy rendering, with a wider margin instead.
- **Editing view** anchors the zoom on a document position and lets CodeMirror scroll it back into place.
- **Touch listeners** sit on the document in the capture phase, so two-finger gestures don't reach Obsidian's own swipe handlers. Canvas is left alone.

Some of this relies on undocumented Obsidian internals (the reading view renderer). Every such access is guarded: if a future Obsidian version changes it, zoom still works, but you may see sections pop in while scrolling a zoomed note.

## License

[MIT](LICENSE)
