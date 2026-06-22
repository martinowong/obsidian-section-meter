# AGENTS.md

## Project overview

Section Meter is an Obsidian community plugin that shows word counts, character counts, reading-time estimates, and writing-target progress beside headings, the note title, and in the status bar.

The plugin is written in TypeScript and bundled into `main.js` with esbuild.

## Repository structure

```text
.
├── main.ts                    # Obsidian plugin, editor UI, status bar, settings
├── src/
│   ├── readingTime.ts         # Markdown parsing, counting, targets, formatting
│   └── readingTime.test.ts    # Unit and regression tests
├── styles.css                 # Badges, progress bars, settings, status bar
├── main.js                    # Generated production bundle
├── esbuild.config.mjs         # Development and production bundling
├── manifest.json              # Obsidian plugin metadata and version
├── versions.json              # Plugin versions and minimum Obsidian versions
├── package.json               # Scripts, dependencies, package version
├── package-lock.json          # Locked dependencies and package version
├── docs/future/               # Deferred designs for newer Obsidian APIs
├── README.md                  # User-facing documentation
└── CHANGELOG.md               # Release history
```

## Where to make changes

### Counting and section behavior

Use `src/readingTime.ts` for:

- Parsing Markdown headings
- Determining section boundaries
- Counting readable words and characters
- Estimating reading time
- Parsing writing targets
- Calculating target progress
- Resolving inherited section targets
- Formatting statistic labels

Keep this module independent from Obsidian and CodeMirror where possible so its behavior remains easy to test.

### Editor and plugin behavior

Use `main.ts` for:

- Plugin loading and unloading
- CodeMirror editor decorations
- Heading and note-title badges
- Selection behavior
- Status-bar output
- Settings controls and migration
- DOM creation and interaction

### Appearance

Use `styles.css` for all visual changes, including badges, target progress bars, status-bar elements, and settings guidance.

### Tests

Add tests to `src/readingTime.test.ts` for changes involving parsing, counting, section boundaries, formatting, or writing targets.

Regression fixes should include a test that fails before the fix and passes afterward.

## Important behavior

A heading section ends immediately before the next heading of the same or a higher level.

Parent sections include the content of nested headings. For example, an H1 includes its H2 and H3 subsections until the next H1.

A writing target belongs to its nearest preceding heading. Parent targets remain active inside untargeted nested headings. A nested heading's own target takes priority within that subsection.

Writing-target lines are visible in the note but excluded from word, character, and reading-time counts.

Readable-text counting also excludes frontmatter, fenced code, inline code, embeds, comments, and HTML.

## Development commands

Install dependencies:

```sh
npm install
```

Run all tests:

```sh
npm test
```

Run Obsidian's plugin checks:

```sh
npm run lint
```

Run tests continuously:

```sh
npm run test:watch
```

Create a production build:

```sh
npm run build
```

Start the development watcher:

```sh
npm run dev
```

## Validation

For TypeScript or behavior changes, run:

```sh
npm run lint
npm test
npm run build
```

For documentation-only changes, tests and a new plugin release are normally unnecessary.

Always run `git diff --check` before committing.

## Generated files

`main.js` is generated from `main.ts` by esbuild.

Do not edit `main.js` manually. After changing TypeScript, run `npm run build` and commit the updated bundle with its source changes.

The deferred Obsidian 1.13 settings design is documented in `docs/future/obsidian-1.13-settings-api.md`. Do not restore it while 1.13 remains a Catalyst-only release.

## Versioning and releases

A plugin release requires the same version in:

- `package.json`
- `package-lock.json`
- `manifest.json`
- `versions.json`
- `CHANGELOG.md`

Release tags use the plain version number, such as `0.11.4`, without a `v` prefix.

Publishing a GitHub release triggers `.github/workflows/release.yml`, which runs the tests, rebuilds the plugin, and attaches:

- `main.js`
- `manifest.json`
- `styles.css`

README-only changes should be pushed without creating a release or changing the plugin version.

## Working guidelines

- Do not use a browser when a local check or quick user verification is sufficient.
- Use `rg` or `rg --files` to find code and files.
- Preserve unrelated changes in the working tree.
- Use `apply_patch` for manual file edits.
- Keep user-facing language friendly and accessible.
- Prefer focused changes over broad refactors.
- Update tests when observable behavior changes.
- Do not edit release versions unless a release is explicitly requested.
