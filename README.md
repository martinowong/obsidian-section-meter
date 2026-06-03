# Section Meter

Section Meter is an Obsidian plugin that shows reading-time badges beside markdown headings and the note title in the editor.

Each heading counts the readable content in its section. A section starts at the heading and ends before the next heading of the same or higher rank, so parent headings include the text in lower-rank child headings.

Vibecoded with Codex by Martino Wong.

## Features

- Editor badges for ATX headings from `#` through `######`.
- A note-title badge showing whole-note counts and reading time.
- Whole-note stats in Obsidian's bottom status bar.
- While text is selected, the nearest heading badge above the selection shows selected-text stats.
- Selected-text stats can appear in Obsidian's bottom status bar.
- Parent sections include nested child-heading content.
- Readable prose counting that excludes frontmatter, code blocks, inline code, embeds, comments, and HTML.
- Minute-and-second timing labels.
- Selectable badge text.
- Toggle controls for word count, timing, and character count labels.
- Separate status-bar toggles for whole-note stats, selected-text stats, words, timing, and characters.
- Character counts include spaces by default, with a toggle to exclude spaces.
- Configurable single-character separator between enabled label parts.
- A reading-speed slider with guidance for read-aloud, typical, and fast reading paces.
- Settings for minimum word count and empty-section visibility.

## Future ideas

- Optional reading-view badges in addition to editor badges.
- Per-note or per-folder words-per-minute overrides.
- A click-to-copy action for heading badges if CodeMirror text selection remains awkward.
- More precise rendered-text counting using Obsidian's markdown parser.
- Optional compact labels such as `1817 chars` instead of `1817 characters`.

## Known Limitations

- Section Meter is editor-only for now; reading view support is deferred.
- Counts are based on fast local Markdown cleanup rather than Obsidian's full Markdown renderer.
- Dynamic plugin output from tools such as Dataview, rendered transclusions, and complex math may not match exactly what appears on screen.

## License

Section Meter is released under the MIT License.

Section Meter is an independent community plugin and is not affiliated with, endorsed by, or sponsored by Obsidian.

## Manual Installation

Download or build the plugin files, then copy these files into `.obsidian/plugins/section-meter` in your vault:

- `main.js`
- `manifest.json`
- `styles.css`

Restart Obsidian or reload plugins, then enable Section Meter from Community plugins.

## Development

Install dependencies:

```sh
npm install
```

Run tests:

```sh
npm test
```

Build the plugin:

```sh
npm run build
```

For local Obsidian testing, copy or symlink this folder into a vault's `.obsidian/plugins/section-meter` directory, run `npm run build`, then enable the plugin in Obsidian.
