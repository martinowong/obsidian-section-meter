import { describe, expect, it } from "vitest";
import {
  countReadableCharacters,
  countReadableWords,
  formatReadingTime,
  formatSeconds,
  parseHeadingSections,
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
  showFloatingSelectionBadge: true
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
      label: "4 words, 0m 02s"
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
