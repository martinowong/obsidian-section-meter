# Changelog

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
