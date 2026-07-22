import { describe, expect, it } from "vitest";
import {
  countReadableCharacters,
  countReadableWords,
  createWritingTargetTextEdit,
  formatReadingTime,
  formatSeconds,
  formatWritingTargetCountLabel,
  getActiveSectionTargetAtPosition,
  getActiveWritingTargetAtPosition,
  parseHeadingSections,
  parseWritingTargetLine,
  summarizeNoteReadingTime,
  summarizeSectionReadingTimes
} from "./readingTime";

const settings = {
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
  showStatusBarNoteStats: true,
  showStatusBarSelectionStats: true,
  showStatusBarWords: true,
  showStatusBarTiming: false,
  showStatusBarCharacters: false,
  targetOverageWarningPercent: 125,
  targetProgressLabelStyle: "count" as const,
  mobileStickySectionMeter: false,
  mobileMeterPosition: "bottom" as const,
  previewSticky: true
};

describe("parseHeadingSections", () => {
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
});

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
});

describe("parseWritingTargetLine", () => {
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
});

describe("writing target progress", () => {
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
