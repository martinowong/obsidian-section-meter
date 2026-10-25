import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  countReadableCharacters,
  countReadableWords,
  createWritingTargetTextEdit,
  formatReadingTime,
  formatSeconds,
  formatWritingTargetCountLabel,
  formatWritingTargetLine,
  getNextTargetProgressLabelStyle,
  getActiveSectionTargetAtPosition,
  getActiveSectionTargetSummaryAtPosition,
  getActiveWritingTargetAtPosition,
  parseHeadingSections,
  parseWritingTargetLine,
  summarizeNoteReadingTime,
  summarizeReadingTimes,
  summarizeSectionReadingTimes
} from "./readingTime";

const settings = {
  enabled: true,
  wordsPerMinute: 200,
  showWords: true,
  showTiming: true,
  showCharacters: false,
  compactMode: false,
  compactWordsLabel: "w",
  compactCharactersLabel: "char",
  compactMinutesLabel: "m",
  showTimeAsMinutesOnly: false,
  countCharactersWithSpaces: true,
  labelSeparator: ",",
  minimumWordCount: 0,
  hideEmptySections: false,
  showHeadingStats: true,
  showInlineTitleStats: true,
  showStatusBarNoteStats: true,
  showStatusBarSelectionStats: true,
  showStatusBarWords: true,
  showStatusBarTiming: false,
  showStatusBarCharacters: false,
  targetOverageWarningPercent: 125,
  targetProgressLabelStyle: "count" as const,
  targetPresets: "250 words, 500 words, 10m",
  notifyOnTargetReached: false,
  classicTargetColors: false,
  showTargetChips: true,
  mobileStickySectionMeter: false,
  mobileMeterPosition: "bottom" as const,
  previewSticky: true
};

describe("manual test-vault fixture", () => {
  it("keeps the whole-note target distinct from parent-section targets", () => {
    const markdown = readFileSync(new URL("../test-vault/Section Writing Stats test cases.md", import.meta.url), "utf8");
    const summaries = summarizeReadingTimes(markdown, settings);
    expect(summaries.note.target?.targetValue).toBe(100);
    expect(summaries.sections[0].target).toBeNull();
    expect(summaries.sections.find((section) => section.title === "Parent section target")?.target?.targetValue).toBe(50);
    expect(summaries.sections.find((section) => section.title === "Short target syntax"))
      .toMatchObject({ wordCount: 3, target: { metric: "words", targetValue: 20 } });
    expect(summaries.sections.find((section) => section.title === "Character target shorthand"))
      .toMatchObject({ characterCount: 11, target: { metric: "characters", targetValue: 30 } });
    expect(summaries.sections.find((section) => section.title === "Target-like prose")?.target).toBeNull();
  });
});

describe("parseHeadingSections", () => {
  it("excludes commented headings, targets, and prose with original edit offsets", () => {
    for (const [open, close] of [["<!--", "-->"], ["%%", "%%"]]) {
      const markdown = `${open}\r\n# Hidden\r\nTarget: 1 words\r\nsecret text\r\n${close}\r\n# Visible\r\nTarget: 10 words\r\nhello world\r\n`;
      const summaries = summarizeReadingTimes(markdown, settings);
      expect(summaries.sections.map((section) => section.title)).toEqual(["Visible"]);
      expect(summaries.sections[0].wordCount).toBe(2);
      expect(summaries.note.wordCount).toBe(3);
      expect(summaries.note.target).toBeNull();
      expect(summaries.sections[0].target?.targetValue).toBe(10);
      const edit = createWritingTargetTextEdit(markdown, "section", markdown.indexOf("hello"), { metric: "words", targetValue: 20 });
      expect(edit && markdown.slice(edit.from, edit.to)).toBe("Target: 10 words");
    }
  });

  it("does not treat horizontal rules inside a section as document frontmatter", () => {
    const markdown = "# Intro\n---\nalpha beta gamma\n---\ndelta epsilon\n";
    expect(summarizeSectionReadingTimes(markdown, settings)[0].wordCount).toBe(5);
  });

  it("ignores unfinished comments without treating comment delimiters in code as comments", () => {
    const markdown = "# Visible\nhello `%%` world\n```text\n<!--\n%%\n```\n## Child\nkept prose\n%% unfinished\n# Hidden\nTarget: 1 words";
    const summaries = summarizeReadingTimes(markdown, settings);
    expect(summaries.sections.map((section) => section.title)).toEqual(["Visible", "Child"]);
    expect(summaries.sections[0].wordCount).toBe(5);
    expect(summaries.sections[1].wordCount).toBe(2);
    expect(summaries.sections[1].target).toBeNull();
    expect(countReadableCharacters("hello %% secret %% world")).toBe(11);
  });

  it("creates a section for a single heading", () => {
    const sections = parseHeadingSections("# Intro\nHello world\n");

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      level: 1,
      title: "Intro",
      line: 0
    });
    expect(sections[0].to).toBe("# Intro\nHello world\n".length);
  });

  it("ends a section before the next same-level heading", () => {
    const markdown = "## One\nalpha beta\n## Two\ngamma\n";
    const sections = parseHeadingSections(markdown);

    expect(sections).toHaveLength(2);
    expect(markdown.slice(sections[0].contentFrom, sections[0].to)).toBe("alpha beta\n");
    expect(markdown.slice(sections[1].contentFrom, sections[1].to)).toBe("gamma\n");
  });

  it("includes lower-rank headings in the parent section", () => {
    const markdown = "# Parent\nparent words\n## Child\nchild words\n# Next\noutside\n";
    const summaries = summarizeSectionReadingTimes(markdown, settings);

    expect(summaries.find((summary) => summary.title === "Parent")?.wordCount).toBe(5);
    expect(summaries.find((summary) => summary.title === "Child")?.wordCount).toBe(2);
  });

  it("excludes sibling and parent-adjacent content from a child section", () => {
    const markdown = "# Parent\nbefore\n## Child\ninside only\n## Sibling\nsibling words\n";
    const child = summarizeSectionReadingTimes(markdown, settings)
      .find((summary) => summary.title === "Child");

    expect(child?.wordCount).toBe(2);
  });
});

describe("countReadableWords", () => {
  it("counts prose-heavy notes through the plain-text path", () => {
    const markdown = [
      "# Plain heading ###",
      "Thirty thousand words can still be mostly plain prose.",
      "A literal hash # remains syntax for compatibility."
    ].join("\n");

    expect(countReadableWords(markdown)).toBe(18);
    expect(countReadableCharacters(markdown)).toBe(118);
  });

  it("keeps apostrophes and hyphens inside ASCII words", () => {
    expect(countReadableWords("It's well-known -- really.")).toBe(3);
  });

  it("matches the previous counters across generated ASCII prose", () => {
    let seed = 0x5ec710;
    const random = () => {
      seed = ((seed * 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
      + "     \t\n\r.,;:!?'/()-";

    for (let sample = 0; sample < 2000; sample++) {
      let prose = "";
      const length = Math.floor(random() * 200);
      for (let index = 0; index < length; index++) {
        prose += alphabet[Math.floor(random() * alphabet.length)];
      }
      prose = `A${prose.replace(/\r\n|\r|\n/g, (lineBreak) => `${lineBreak}A`)}`;

      expect(countReadableWords(prose)).toBe(referenceWordCount(prose));
      expect(countReadableCharacters(prose, true))
        .toBe(referenceCharacterCount(prose, true));
      expect(countReadableCharacters(prose, false))
        .toBe(referenceCharacterCount(prose, false));
    }
  });

  it("counts prose, lists, links, blockquotes, and table cell text", () => {
    const markdown = [
      "A paragraph with [linked words](https://example.com).",
      "- List item words",
      "> Quoted words here",
      "| First cell | Second cell |"
    ].join("\n");

    expect(countReadableWords(markdown)).toBe(15);
  });

  it("excludes frontmatter, fenced code, inline code, comments, embeds, and html", () => {
    const markdown = [
      "---",
      "title: Hidden Words",
      "---",
      "Visible words",
      "```ts",
      "const hidden = 'code words';",
      "```",
      "More `inline hidden` words",
      "<!-- hidden comment words -->",
      "![[Embedded Note]]",
      "<div>hidden html words</div>"
    ].join("\n");

    expect(countReadableWords(markdown)).toBe(4);
  });

  it("counts readable characters after stripping markdown syntax", () => {
    expect(countReadableCharacters("Hello **wide** world")).toBe(16);
  });

  it("counts punctuation and repeated spaces as visible characters", () => {
    expect(countReadableCharacters("1 h  .")).toBe(6);
  });

  it("counts a selected paragraph boundary as a visible spacing character", () => {
    const markdown = "\nè più probabile pikachu? è più probabile geodude? oppure hanno la stessa probabilità?";

    expect(countReadableCharacters(markdown)).toBe(86);
  });

  it("can count readable characters without spaces", () => {
    expect(countReadableCharacters("Hello **wide** world", false)).toBe(14);
    expect(countReadableCharacters("1 h  .", false)).toBe(3);
  });

  it("does not count table separator rows as readable characters", () => {
    const markdown = "| A | B |\n| --- | --- |\n| one | two |";

    expect(countReadableWords(markdown)).toBe(4);
    expect(countReadableCharacters(markdown)).toBe(11);
  });

  it("does not count horizontal rules as readable characters", () => {
    const markdown = "Before\n---\nAfter";

    expect(countReadableWords(markdown)).toBe(2);
    expect(countReadableCharacters(markdown)).toBe(12);
  });

  it("does not count task markers as readable words", () => {
    const markdown = "- [x] done\n- [ ] todo";

    expect(countReadableWords(markdown)).toBe(2);
    expect(countReadableCharacters(markdown)).toBe(9);
  });

  it("does not leave removed blocks behind as counted spaces", () => {
    const markdown = [
      "---",
      "title: Hidden Words",
      "---",
      "Visible words",
      "```ts",
      "const hidden = 'code words';",
      "```",
      "More `inline hidden` words",
      "<!-- hidden comment words -->",
      "![[Embedded Note]]",
      "<div>hidden html words</div>"
    ].join("\n");

    expect(countReadableCharacters(markdown)).toBe(24);
  });

  it("does not count valid target lines as readable prose", () => {
    const markdown = "Target: 1,200 words\nVisible words\nTarget: not valid";

    expect(countReadableWords(markdown)).toBe(5);
    expect(countReadableCharacters(markdown)).toBe(31);
  });

  it("excludes the new standalone forms on the plain-text path but preserves target-like prose", () => {
    const markdown = "target 10w\ntarget 20 chars\none two\nTarget: 5 words today";
    expect(countReadableWords(markdown)).toBe(6);
    expect(countReadableCharacters(markdown)).toBe(29);
    expect(countReadableWords("Target: 500")).toBe(2);
    expect(countReadableWords("Target: 1,00 words")).toBe(4);
  });
});

function referenceWordCount(readable: string): number {
  return readable.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function referenceCharacterCount(readable: string, includeSpaces: boolean): number {
  const lineTrimmed = readable.replace(/^[^\S\r\n]+|[^\S\r\n]+$/gm, "");
  const hasContent = /\S/.test(lineTrimmed);
  const keepLeadingBreak = hasContent && /^(?:\r\n|\r|\n)/.test(lineTrimmed);
  let normalized = lineTrimmed
    .replace(/\t/g, " ")
    .replace(/(?:\r\n|\r|\n)+/g, " ");

  if (!keepLeadingBreak) {
    normalized = normalized.replace(/^ +/, "");
  }

  normalized = normalized.replace(/ +$/, "");
  const countable = includeSpaces ? normalized : normalized.replace(/\s/g, "");
  return Array.from(countable).length;
}

describe("formatReadingTime", () => {
  it("rounds nonzero counts up to at least one second", () => {
    expect(formatReadingTime(1, 5, {
      ...settings,
      showWords: false,
      showTiming: true
    })).toBe("0m 01s");
  });

  it("respects configured words per minute", () => {
    expect(formatReadingTime(401, 2000, {
      ...settings,
      wordsPerMinute: 200,
      showWords: false,
      showTiming: true
    }))
      .toBe("2m 01s");
    expect(formatReadingTime(401, 2000, {
      ...settings,
      wordsPerMinute: 500,
      showWords: false,
      showTiming: true
    }))
      .toBe("0m 49s");
  });

  it("can include words and timing", () => {
    expect(formatReadingTime(640, 3200, settings))
      .toBe("640 words, 3m 12s");
  });

  it("can show only word count", () => {
    expect(formatReadingTime(640, 3200, {
      ...settings,
      showTiming: false
    }))
      .toBe("640 words");
  });

  it("can show characters and character combinations", () => {
    expect(formatReadingTime(640, 3200, {
      ...settings,
      showWords: false,
      showTiming: false,
      showCharacters: true
    }))
      .toBe("3200 characters");
    expect(formatReadingTime(640, 3200, {
      ...settings,
      showWords: false,
      showCharacters: true
    }))
      .toBe("3200 characters, 3m 12s");
    expect(formatReadingTime(640, 3200, {
      ...settings,
      showTiming: false,
      showCharacters: true
    }))
      .toBe("640 words, 3200 characters");
    expect(formatReadingTime(640, 3200, {
      ...settings,
      showCharacters: true
    }))
      .toBe("640 words, 3200 characters, 3m 12s");
  });

  it("uses a custom separator character between enabled parts", () => {
    expect(formatReadingTime(640, 3200, {
      ...settings,
      labelSeparator: "|",
      showCharacters: true
    }))
      .toBe("640 words | 3200 characters | 3m 12s");
  });

  it("can use compact labels for words, characters, and time", () => {
    expect(formatReadingTime(640, 3200, {
      ...settings,
      showCharacters: true,
      compactMode: true
    }))
      .toBe("640w, 3200 char, 3m");
    expect(formatReadingTime(700, 3500, {
      ...settings,
      showCharacters: true,
      compactMode: true
    }))
      .toBe("700w, 3500 char, 4m");
    expect(formatReadingTime(1, 5, {
      ...settings,
      showWords: false,
      showCharacters: false,
      compactMode: true
    }))
      .toBe("1s");
  });

  it("can show time as minutes only without compacting counts", () => {
    expect(formatReadingTime(640, 3200, {
      ...settings,
      showTimeAsMinutesOnly: true
    }))
      .toBe("640 words, 3m");
    expect(formatReadingTime(700, 3500, {
      ...settings,
      showTimeAsMinutesOnly: true
    }))
      .toBe("700 words, 4m");
    expect(formatReadingTime(1, 5, {
      ...settings,
      showWords: false,
      showTimeAsMinutesOnly: true
    }))
      .toBe("1s");
  });

  it("uses customized labels in compact mode", () => {
    expect(formatReadingTime(640, 3200, {
      ...settings,
      showCharacters: true,
      compactMode: true,
      compactWordsLabel: "wd",
      compactCharactersLabel: "ch",
      compactMinutesLabel: "min"
    }))
      .toBe("640wd, 3200 ch, 3min");
  });

  it("falls back to default compact labels when customized labels are empty", () => {
    expect(formatReadingTime(640, 3200, {
      ...settings,
      showCharacters: true,
      compactMode: true,
      compactWordsLabel: "",
      compactCharactersLabel: " ",
      compactMinutesLabel: ""
    }))
      .toBe("640w, 3200 char, 3m");
  });

  it("formats zero-padded minute and second labels", () => {
    expect(formatSeconds(0)).toBe("0m 00s");
    expect(formatSeconds(72)).toBe("1m 12s");
  });
});

describe("summarizeNoteReadingTime", () => {
  it("summarizes readable words across the whole note", () => {
    const summary = summarizeNoteReadingTime("# Title\nReadable note words", settings);

    expect(summary).toEqual({
      wordCount: 4,
      characterCount: 25,
      seconds: 2,
      label: "4 words, 0m 02s",
      target: null
    });
  });

  it("respects the character spacing setting", () => {
    const summary = summarizeNoteReadingTime("# Title\nReadable note words", {
      ...settings,
      countCharactersWithSpaces: false
    });

    expect(summary.characterCount).toBe(22);
  });

  it("can summarize note and section stats in one analysis", () => {
    const markdown = [
      "Target: 10 words",
      "# Parent",
      "Target: 4 words",
      "parent words",
      "## Child",
      "child words"
    ].join("\n");
    const summaries = summarizeReadingTimes(markdown, settings);

    expect(summaries.note).toEqual(summarizeNoteReadingTime(markdown, settings));
    expect(summaries.sections).toEqual(summarizeSectionReadingTimes(markdown, settings));
  });
});

describe("parseWritingTargetLine", () => {
  it("does not treat Goal declarations as targets or exclude them from prose counts", () => {
    for (const line of ["Goal: 500 words", "goal 500w", "GOAL: 30 chars", "Goal: 2m 30s"]) {
      expect(parseWritingTargetLine(line), line).toBeNull();
    }
    const markdown = "Goal: 500 words\nhello";
    expect(countReadableWords(markdown)).toBe(4);
    expect(summarizeNoteReadingTime(markdown, settings).target).toBeNull();
  });

  it("accepts explicit target lines with optional colons and word shorthand", () => {
    for (const line of ["target 500w", "Target: 500w", "Target: 500 words", "TARGET 500 words", "  Target : 500 words  "]) {
      expect(parseWritingTargetLine(line), line).toEqual({ metric: "words", targetValue: 500 });
    }
    expect(parseWritingTargetLine("Target 1,000 chars")).toEqual({ metric: "characters", targetValue: 1000 });
    expect(parseWritingTargetLine("target 2m 30s")).toEqual({ metric: "reading-time", targetValue: 150 });
  });

  it("parses word and character targets", () => {
    expect(parseWritingTargetLine("Target: 250 words")).toEqual({
      metric: "words",
      targetValue: 250
    });
    expect(parseWritingTargetLine("target: 1,800 chars")).toEqual({
      metric: "characters",
      targetValue: 1800
    });
    expect(parseWritingTargetLine("Target: 1 character")).toEqual({
      metric: "characters",
      targetValue: 1
    });
  });

  it("parses reading-time targets", () => {
    expect(parseWritingTargetLine("Target: 3 min")).toEqual({
      metric: "reading-time",
      targetValue: 180
    });
    expect(parseWritingTargetLine("Target: 3m")).toEqual({
      metric: "reading-time",
      targetValue: 180
    });
    expect(parseWritingTargetLine("Target: 2m 30s")).toEqual({
      metric: "reading-time",
      targetValue: 150
    });
  });

  it("ignores invalid or partial target lines", () => {
    expect(parseWritingTargetLine("Target: someday")).toBeNull();
    expect(parseWritingTargetLine("- Target: 250 words")).toBeNull();
    expect(parseWritingTargetLine("Paragraph target: 250 words")).toBeNull();
  });

  it("requires standalone declarations, explicit units and valid numeric values", () => {
    const invalid = [
      "Target 500", "Target: 500", "Target500w", "Target=500w",
      "Targeting 500 words", "My target 500w", "Target: 500 words today",
      "- Target: 500 words", "> target 500w", "    Target: 500w", "\tTarget: 500 words",
      "Target: +300 words", "Target: -300 words", "Target: 0 words", "Target: 0 chars",
      "Target: 2.5 words", "Target: 1,00 words", "Target: 1,,000 chars", "Target: 1000, words",
      "Target: 9007199254740992 words", "Target: 999999999999999999999 minutes",
      "Target: 1,0m", "Target: 1m 60s", "Target: 0m 0s", "Target: 500w\n",
      "Target:\n500 words"
    ];
    for (const line of invalid) expect(parseWritingTargetLine(line), line).toBeNull();
    expect(parseWritingTargetLine("Target: 12,345,678 words")?.targetValue).toBe(12345678);
    expect(parseWritingTargetLine("Target: 0m 30s")).toEqual({ metric: "reading-time", targetValue: 30 });
  });

  it("accepts seconds-only reading-time targets and writes short ones without minutes", () => {
    expect(parseWritingTargetLine("Target: 30s")).toEqual({ metric: "reading-time", targetValue: 30 });
    expect(parseWritingTargetLine("target 45 sec")).toEqual({ metric: "reading-time", targetValue: 45 });
    expect(parseWritingTargetLine("Target: 90s")).toEqual({ metric: "reading-time", targetValue: 90 });
    expect(parseWritingTargetLine("Target: 0s")).toBeNull();
    expect(formatWritingTargetLine({ metric: "reading-time", targetValue: 30 })).toBe("Target: 30s");
    expect(formatWritingTargetLine({ metric: "reading-time", targetValue: 150 })).toBe("Target: 2m 30s");
  });
});

describe("writing target progress", () => {
  it("uses alternate declarations for note and section targets with unchanged ownership", () => {
    const markdown = "target 100w\n# Draft\ntarget 10w\none two\n## Child\nTarget: 20 chars\nabc";
    const summaries = summarizeReadingTimes(markdown, settings);
    expect(summaries.note).toMatchObject({ wordCount: 5, characterCount: 23,
      target: { metric: "words", targetValue: 100, currentValue: 5 } });
    expect(summaries.sections[0]).toMatchObject({ wordCount: 4,
      target: { metric: "words", targetValue: 10, currentValue: 4 } });
    expect(summaries.sections[1]).toMatchObject({ wordCount: 1,
      target: { metric: "characters", targetValue: 20, currentValue: 3 } });
  });

  it("does not interpret alternate declarations inside frontmatter, code, comments, lists or quotes", () => {
    const markdown = ["---", "target 100w", "---", "# Draft", "```text", "target 20w", "```",
      "%%", "Target: 30 chars", "%%", "<!-- target 40w -->", "- target 50w", "> Target: 60 words", "hello"].join("\n");
    const summaries = summarizeReadingTimes(markdown, settings);
    expect(summaries.note.target).toBeNull();
    expect(summaries.sections[0].target).toBeNull();
    expect(summaries.sections[0].wordCount).toBe(6);
  });

  it("applies a target before the first heading to the whole note", () => {
    const summary = summarizeNoteReadingTime(
      "Target: 4 words\n# Title\nReadable note words",
      settings
    );

    expect(summary.wordCount).toBe(4);
    expect(summary.target).toMatchObject({
      metric: "words",
      currentValue: 4,
      targetValue: 4,
      percent: 100,
      isComplete: true,
      isOverageWarning: false,
      label: "4 / 4 w"
    });
  });

  it("applies section targets to the nearest preceding heading", () => {
    const markdown = [
      "# One",
      "Target: 4 words",
      "alpha beta",
      "## Child",
      "Target: 10 characters",
      "gamma"
    ].join("\n");
    const summaries = summarizeSectionReadingTimes(markdown, settings);

    expect(summaries.find((summary) => summary.title === "One")?.target).toMatchObject({
      metric: "words",
      currentValue: 4,
      targetValue: 4,
      label: "4 / 4 w"
    });
    expect(summaries.find((summary) => summary.title === "Child")?.target).toMatchObject({
      metric: "characters",
      currentValue: 5,
      targetValue: 10,
      label: "5 / 10 c"
    });
  });

  it("uses the first target line owned by a section", () => {
    const summary = summarizeSectionReadingTimes([
      "# Draft",
      "Target: 10 words",
      "Target: 20 words",
      "draft words"
    ].join("\n"), settings)[0];

    expect(summary.target).toMatchObject({
      metric: "words",
      targetValue: 10
    });
  });

  it("includes child content in parent target progress", () => {
    const markdown = [
      "# Parent",
      "Target: 6 words",
      "parent words",
      "## Child",
      "child words here"
    ].join("\n");
    const parent = summarizeSectionReadingTimes(markdown, settings)
      .find((summary) => summary.title === "Parent");

    expect(parent?.wordCount).toBe(6);
    expect(parent?.target).toMatchObject({
      currentValue: 6,
      targetValue: 6,
      isComplete: true
    });
  });

  it("keeps a parent target active inside untargeted child headings", () => {
    const markdown = [
      "# Parent",
      "Target: 20 words",
      "parent words",
      "## Child",
      "child words",
      "### Grandchild",
      "grandchild words"
    ].join("\n");
    const summaries = summarizeSectionReadingTimes(markdown, settings);

    expect(getActiveSectionTargetAtPosition(
      summaries,
      markdown.indexOf("child words")
    )).toMatchObject({ targetValue: 20 });
    expect(getActiveSectionTargetAtPosition(
      summaries,
      markdown.indexOf("grandchild words")
    )).toMatchObject({ targetValue: 20 });
  });

  it("prefers a nested target while the cursor is inside that subsection", () => {
    const markdown = [
      "# Parent",
      "Target: 20 words",
      "## Child",
      "Target: 5 words",
      "child words",
      "## Sibling",
      "sibling words"
    ].join("\n");
    const summaries = summarizeSectionReadingTimes(markdown, settings);

    expect(getActiveSectionTargetAtPosition(
      summaries,
      markdown.indexOf("child words")
    )).toMatchObject({ targetValue: 5 });
    expect(getActiveSectionTargetAtPosition(
      summaries,
      markdown.indexOf("sibling words")
    )).toMatchObject({ targetValue: 20 });
  });

  it("keeps inherited section targets active in the mobile meter", () => {
    const markdown = [
      "# Parent",
      "Target: 20 words",
      "## Child",
      "child words"
    ].join("\n");
    const summaries = summarizeSectionReadingTimes(markdown, settings);

    expect(getActiveWritingTargetAtPosition(
      summaries,
      null,
      markdown.indexOf("child words")
    )).toMatchObject({ targetValue: 20 });
    expect(getActiveSectionTargetSummaryAtPosition(
      summaries,
      markdown.indexOf("child words")
    )).toMatchObject({
      title: "Parent",
      wordCount: 3,
      target: { targetValue: 20 }
    });
  });

  it("falls back to the whole-note target in the mobile meter", () => {
    const markdown = [
      "Target: 100 words",
      "# Section",
      "section words"
    ].join("\n");
    const summaries = summarizeSectionReadingTimes(markdown, settings);
    const noteTarget = summarizeNoteReadingTime(markdown, settings).target;

    expect(getActiveWritingTargetAtPosition(
      summaries,
      noteTarget,
      markdown.indexOf("section words")
    )).toMatchObject({ targetValue: 100 });
  });

  it("supports reading-time target progress", () => {
    const markdown = [
      "# Timed",
      "Target: 1m",
      Array.from({ length: 200 }, (_, index) => `word${index}`).join(" ")
    ].join("\n");
    const timed = summarizeSectionReadingTimes(markdown, settings)[0];

    expect(timed.seconds).toBe(60);
    expect(timed.target).toMatchObject({
      metric: "reading-time",
      currentValue: 60,
      targetValue: 60,
      percent: 100,
      label: "1m 00s / 1m 00s"
    });
  });

  it("marks progress over the configured threshold as an overage warning", () => {
    const warning = summarizeSectionReadingTimes("# Long\nTarget: 4 words\none two three four five", settings)[0];
    const complete = summarizeSectionReadingTimes("# Exact\nTarget: 4 words\none two three four", settings)[0];

    expect(complete.target).toMatchObject({
      percent: 100,
      isComplete: true,
      isOverageWarning: false
    });
    expect(warning.target).toMatchObject({
      percent: 125,
      isComplete: true,
      isOverageWarning: true
    });
  });

  it("can show target progress as a percentage", () => {
    const summary = summarizeSectionReadingTimes("# Draft\nTarget: 8 words\none two three four", {
      ...settings,
      targetProgressLabelStyle: "percentage"
    })[0];

    expect(summary.target).toMatchObject({
      currentValue: 4,
      targetValue: 8,
      percent: 50,
      label: "50%"
    });
  });

  it("can show the remaining amount for word, character, and reading-time targets", () => {
    const wordTarget = summarizeSectionReadingTimes("# Draft\nTarget: 8 words\none two three four", {
      ...settings,
      targetProgressLabelStyle: "remaining"
    })[0];
    const characterTarget = summarizeSectionReadingTimes("# Draft\nTarget: 10 characters\nhello", {
      ...settings,
      targetProgressLabelStyle: "remaining"
    })[0];
    const timedTarget = summarizeSectionReadingTimes([
      "# Timed",
      "Target: 1m",
      Array.from({ length: 100 }, (_, index) => `word${index}`).join(" ")
    ].join("\n"), {
      ...settings,
      targetProgressLabelStyle: "remaining"
    })[0];

    expect(wordTarget.target?.label).toBe("4 words left");
    expect(characterTarget.target?.label).toBe("5 characters left");
    expect(timedTarget.target?.label).toBe("0m 30s left");
  });

  it("labels completed remaining targets as reached", () => {
    const summary = summarizeSectionReadingTimes("# Draft\nTarget: 2 words\none two", {
      ...settings,
      targetProgressLabelStyle: "remaining"
    })[0];

    expect(summary.target?.label).toBe("Reached");
  });

  it("labels exceeded remaining targets with the overage", () => {
    const remainingSettings = { ...settings, targetProgressLabelStyle: "remaining" as const };
    const wordTarget = summarizeSectionReadingTimes(
      "# Draft\nTarget: 2 words\none two three", remainingSettings)[0];
    const characterTarget = summarizeSectionReadingTimes(
      "# Draft\nTarget: 3 characters\nhello", remainingSettings)[0];
    const timedTarget = summarizeSectionReadingTimes([
      "# Timed",
      "Target: 1m",
      Array.from({ length: 300 }, (_, index) => `word${index}`).join(" ")
    ].join("\n"), remainingSettings)[0];

    expect(wordTarget.target?.label).toBe("1 word over");
    expect(characterTarget.target?.label).toBe("2 characters over");
    expect(timedTarget.target?.label).toBe("0m 30s over");
  });
});

describe("formatWritingTargetCountLabel", () => {
  it("formats compact word, character, and reading-time target counts", () => {
    expect(formatWritingTargetCountLabel({
      metric: "words",
      currentValue: 1510,
      targetValue: 10000
    })).toBe("1510 / 10000 w");
    expect(formatWritingTargetCountLabel({
      metric: "characters",
      currentValue: 1510,
      targetValue: 10000
    })).toBe("1510 / 10000 c");
    expect(formatWritingTargetCountLabel({
      metric: "reading-time",
      currentValue: 150,
      targetValue: 300
    })).toBe("2m 30s / 5m 00s");
  });
});

describe("getNextTargetProgressLabelStyle", () => {
  it("cycles count, percentage, and remaining in order", () => {
    expect(getNextTargetProgressLabelStyle("count")).toBe("percentage");
    expect(getNextTargetProgressLabelStyle("percentage")).toBe("remaining");
    expect(getNextTargetProgressLabelStyle("remaining")).toBe("count");
  });
});

describe("writing target text edits", () => {
  it("inserts a whole-note target after frontmatter", () => {
    const markdown = "---\ntitle: Draft\n---\n# Intro\nOpening words";
    const edit = createWritingTargetTextEdit(
      markdown,
      "note",
      0,
      { metric: "words", targetValue: 1200 }
    );

    expect(applyTextEdit(markdown, edit)).toBe(
      "---\ntitle: Draft\n---\nTarget: 1200 words\n\n# Intro\nOpening words"
    );
  });

  it("separates a target from frontmatter that ends at the end of the file", () => {
    const markdown = "---\ntitle: Draft\n---";
    const edit = createWritingTargetTextEdit(
      markdown,
      "note",
      0,
      { metric: "words", targetValue: 500 }
    );

    expect(applyTextEdit(markdown, edit)).toBe(
      "---\ntitle: Draft\n---\nTarget: 500 words"
    );
  });

  it("updates an existing target without adding another line", () => {
    const markdown = "Target: 500 words\n\n# Draft\nText";
    const edit = createWritingTargetTextEdit(
      markdown,
      "note",
      markdown.length,
      { metric: "characters", targetValue: 3000 }
    );

    expect(applyTextEdit(markdown, edit)).toBe(
      "Target: 3000 characters\n\n# Draft\nText"
    );
  });

  it("edits and removes alternate declarations without adding duplicate targets", () => {
    const markdown = "target 100w\n# Draft\ntarget 10w\none two\n## Child\nTarget: 20 chars\nabc";
    const noteEdit = createWritingTargetTextEdit(markdown, "note", 0,
      { metric: "words", targetValue: 200 });
    expect(applyTextEdit(markdown, noteEdit)).toBe(
      "Target: 200 words\n# Draft\ntarget 10w\none two\n## Child\nTarget: 20 chars\nabc"
    );
    const sectionEdit = createWritingTargetTextEdit(markdown, "section", markdown.indexOf("one two"),
      { metric: "words", targetValue: 15 });
    expect(applyTextEdit(markdown, sectionEdit)).toBe(
      "target 100w\n# Draft\nTarget: 15 words\none two\n## Child\nTarget: 20 chars\nabc"
    );
    const removal = createWritingTargetTextEdit(markdown, "section", markdown.indexOf("abc"), null);
    expect(applyTextEdit(markdown, removal)).toBe(
      "target 100w\n# Draft\ntarget 10w\none two\n## Child\nabc"
    );
  });

  it("adds a target to the nested section containing the cursor", () => {
    const markdown = "# Parent\nParent text\n## Child\nChild text";
    const edit = createWritingTargetTextEdit(
      markdown,
      "section",
      markdown.indexOf("Child text"),
      { metric: "reading-time", targetValue: 150 }
    );

    expect(applyTextEdit(markdown, edit)).toBe(
      "# Parent\nParent text\n## Child\nTarget: 2m 30s\n\nChild text"
    );
  });

  it("removes only the current section's own target", () => {
    const markdown = [
      "# Parent",
      "Target: 1000 words",
      "## Child",
      "Target: 250 words",
      "Child text"
    ].join("\n");
    const edit = createWritingTargetTextEdit(
      markdown,
      "section",
      markdown.indexOf("Child text"),
      null
    );

    expect(applyTextEdit(markdown, edit)).toBe([
      "# Parent",
      "Target: 1000 words",
      "## Child",
      "Child text"
    ].join("\n"));
  });

  it("does not create a section target before the first heading", () => {
    const markdown = "Introductory text\n# Draft\nWords";

    expect(createWritingTargetTextEdit(
      markdown,
      "section",
      5,
      { metric: "words", targetValue: 250 }
    )).toBeNull();
  });
});

function applyTextEdit(
  markdown: string,
  edit: ReturnType<typeof createWritingTargetTextEdit>
): string {
  if (!edit) {
    throw new Error("Expected a writing target edit");
  }

  return markdown.slice(0, edit.from) + edit.text + markdown.slice(edit.to);
}
