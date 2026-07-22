# Changelog

## 1.0.2

- Made the Beta mobile target meter smaller and added a top or bottom position setting. The bottom position now stays above Obsidian's mobile command toolbar.
- Fixed the mobile meter disappearing inside untargeted child headings or when a whole-note target was active.

## 1.0.1

- Replaced the Beta mobile section card with a compact writing-target progress strip near the keyboard. Tap it to switch between percentage and current/target values.

## 1.0.0

- Renamed the plugin to Section Writing Stats, with clearer documentation and search-friendly metadata describing its word counts, character counts, reading time, section statistics, and writing targets.
- Added command-palette actions to set, edit, and remove writing targets for the whole note or the section containing the cursor.
- Refined the optional Beta mobile meter so it is more compact and follows the section currently visible in the editor more promptly.
- Kept the stable `section-meter` plugin ID, so existing installations and settings continue to update normally.

## 0.13.0

- Improved the live settings preview: it is now more compact and more closely matches how heading badges and the status bar appear in Obsidian.
- Added a compact display mode with shorter labels for word counts, character counts, and reading times. The labels can be customized.
- Added a minutes-only option for a cleaner reading-time display.
- Beta: added an optional sticky meter for mobile that shows the section currently in view, its stats, and its writing target while you scroll. Enable it in the Mobile settings if you would like to try it.

## 0.12.0

- Section Meter now has a sticky live preview in settings, so you can immediately see how your heading badges and status bar will look while you adjust them, plus new compact and minutes-only display options for a cleaner writing view.

## 0.11.7

- Removed the Catalyst-only declarative settings APIs from the shipped plugin while preserving that work as future-release documentation.

## 0.11.6

- Fixed the legacy settings renderer to use APIs supported by the declared minimum Obsidian version.
- Added Obsidian's official plugin lint checks to local development and the release workflow.

## 0.11.5

- Restored support for the public Obsidian release line by making the settings screen compatible with Obsidian 1.11 and newer.

## 0.11.4

- Kept parent-heading writing targets visible in the status bar while the cursor is inside nested headings.
- Preferred a nested heading's own target within its subsection and restored the parent target in untargeted sibling sections.

## 0.11.3

- Updated settings section headings to follow Obsidian's sentence-case UI style.

## 0.11.2

- Declared Obsidian 1.13.0 as the minimum app version for the reorganized settings menu.
- Kept timer scheduling on the global window for Obsidian compatibility.

## 0.11.1

- Fixed release review warnings around typed settings data, popout-window document usage, settings API deprecations, section array typing, and a Markdown cleanup regex.
- Reorganized the settings menu into clearer Badge display, Counting rules, Status bar, and Writing targets groups.

## 0.11.0

- Added visible `Target: ...` writing goals for whole notes and heading sections.
- Added target progress bars with grey, yellow, light-green, green, and red states.
- Added target progress to heading badges, the note-title badge, and the status bar.
- Added settings for the overage warning threshold and target label style.
- Debounced selection-driven heading badge updates to reduce jitter while selecting text.

## 0.10.4

- Fixed the title badge in mobile and narrow editor layouts by inserting it directly after the inline title.

## 0.10.3

- Replaced the `builtin-modules` development dependency with Node's built-in module list.
- Added a GitHub Actions release workflow that rebuilds, uploads, and attests release assets.

## 0.10.2

- Replaced floating selection stats with a bottom status-bar readout.
- Added whole-note stats to the status bar.
- Added separate status-bar display toggles for whole-note stats, selected-text stats, words, timing, and characters.
- Kept heading badges to one section badge per visible heading.

## 0.10.1

- Fixed floating selection stats so the badge anchors to the visible editor pane when the target heading is offscreen.

## 0.10.0

- Added a floating selection badge when the target heading is scrolled out of view.
- Added selected-text stats on the nearest heading above the selection.
- Added word count, character count, and timing label toggles.
- Added character counting with spaces enabled by default and a setting to exclude spaces.
- Added a reading-speed slider with guidance text.
- Added configurable label separators.
- Added whole-note stats beside the note title.
- Improved readable text counting for tables, task lists, horizontal rules, hidden blocks, and punctuation.

## 0.1.0

- Initial Section Meter implementation for editor heading badges.
