# Section Writing Stats test cases

Use this note after `npm run install:test-vault` to check the plugin in Obsidian's editor and Reading view.

Target: 100 words

This note deliberately contains targets, nested headings, punctuation, emoji 👋, inline code like `const ignored = true`, and a fenced code block. The count should include readable prose only, and the whole-note target should remain active in sections without their own target.

## Inherited target

This section has no target of its own, so it should show the 100-word whole-note target. Edit this heading, delete and retype part of it, and move the cursor around it. The badge must not enter the editable heading or make the editor jump.

### Section word target

Target: 25 words

This child has its own 25-word target. Its badge should take priority over the inherited whole-note target. Check all three target label styles: count, percentage, and remaining.

#### Nested child inherits section target

This heading has no target. Its statistics should include this text while its target remains the 25-word one above.

## Character target

Target: 120 characters

Accented text such as café, emoji 🚀, and punctuation should be counted according to the character-count setting. Edit this heading as well; the badge should remain outside the editable title.

```ts
// This code fence must not affect words or characters.
const ignored = "Section Writing Stats";
```

## Reading-time target

Target: 1m 30s

This section checks the time target display. Change the reading speed in settings and confirm the time label and progress update.

## Empty heading

Type a heading title here, delete it, then type it again. The title and the badge must never merge or swap places.
