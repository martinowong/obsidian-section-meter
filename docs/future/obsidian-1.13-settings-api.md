# Future Obsidian 1.13 settings API

The declarative settings implementation is intentionally not part of the current plugin source because Obsidian 1.13 is still a Catalyst release. Shipping those APIs prevents users on the public Obsidian release from receiving plugin updates.

## Preserved implementation

The complete implementation is preserved in Git history at:

- Tag: `0.11.6`
- Commit: `64a62f5`
- File: `main.ts`
- Class: `SectionMeterSettingTab`

That version contains:

- `getSettingDefinitions()`
- `SettingDefinitionGroup` sections
- Searchable setting names and descriptions
- Declarative render callbacks for the existing controls

## Future migration

Revisit this implementation when Obsidian 1.13 or newer becomes the public release and the plugin can safely raise `minAppVersion`.

When restoring it:

1. Raise `minAppVersion` in `manifest.json` and `versions.json`.
2. Restore the declarative setting definitions from tag `0.11.6`.
3. Remove the legacy `display()` renderer instead of combining both APIs.
4. Use `this.update()` when a settings change requires the tab to refresh.
5. Run `npm run lint`, `npm test`, and `npm run build` before release.
