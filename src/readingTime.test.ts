import { describe, expect, it } from "vitest";
import {
  countReadableCharacters,
  countReadableWords,
  formatReadingTime,
  formatSeconds,
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
  targetProgressLabelStyle: "count" as const
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
