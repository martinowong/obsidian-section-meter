export type LegacyLabelStyle =
  | "words"
  | "time"
  | "characters"
  | "words-and-time"
  | "words-and-minutes"
  | "words-and-characters"
  | "characters-and-time"
  | "words-characters-and-time";

export interface SectionMeterSettings {
  wordsPerMinute: number;
  showWords: boolean;
  showTiming: boolean;
  showCharacters: boolean;
  countCharactersWithSpaces: boolean;
  labelSeparator: string;
  minimumWordCount: number;
  hideEmptySections: boolean;
  showFloatingSelectionBadge: boolean;
}

export interface HeadingSection {
  level: number;
  title: string;
  line: number;
  from: number;
  headingEnd: number;
  contentFrom: number;
  to: number;
}

export interface SectionMeterSummary extends HeadingSection {
  wordCount: number;
  characterCount: number;
  seconds: number;
  label: string;
}

interface ParsedLine {
  text: string;
  from: number;
  to: number;
  lineBreakTo: number;
}

interface HeadingCandidate {
  level: number;
  title: string;
  line: number;
  from: number;
  headingEnd: number;
  contentFrom: number;
}

const DEFAULT_WORDS_PER_MINUTE = 200;

export function parseHeadingSections(markdown: string): HeadingSection[] {
  const lines = splitLines(markdown);
  const headings: HeadingCandidate[] = [];
  let inFence: { marker: string; length: number } | null = null;
  let inFrontmatter = lines[0]?.text.trim() === "---";

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.text.trim();

    if (inFrontmatter) {
      if (index > 0 && (trimmed === "---" || trimmed === "...")) {
        inFrontmatter = false;
      }
      continue;
    }

    const fence = parseFence(line.text);
    if (fence) {
      if (!inFence) {
        inFence = fence;
      } else if (fence.marker === inFence.marker && fence.length >= inFence.length) {
        inFence = null;
      }
      continue;
    }

    if (inFence) {
      continue;
    }

    const heading = parseAtxHeading(line.text);
    if (!heading) {
      continue;
    }

    headings.push({
      ...heading,
      line: index,
      from: line.from,
      headingEnd: line.to,
      contentFrom: line.lineBreakTo
    });
  }

  const sections: HeadingSection[] = new Array(headings.length);
  const openHeadingIndexes: number[] = [];

  headings.forEach((heading, index) => {
    while (openHeadingIndexes.length > 0) {
      const previousIndex = openHeadingIndexes[openHeadingIndexes.length - 1];
      if (headings[previousIndex].level < heading.level) {
        break;
      }

      const previousHeading = headings[previousIndex];
      sections[previousIndex] = {
        ...previousHeading,
        to: heading.from
      };
      openHeadingIndexes.pop();
    }

    openHeadingIndexes.push(index);
  });

  for (const index of openHeadingIndexes) {
    sections[index] = {
      ...headings[index],
      to: markdown.length
    };
  }

  return sections;
}

export function summarizeSectionReadingTimes(
  markdown: string,
  settings: SectionMeterSettings
): SectionMeterSummary[] {
  return parseHeadingSections(markdown).map((section) => {
    const content = markdown.slice(section.contentFrom, section.to);
    const readableText = stripMarkdownToReadableText(content);
    const wordCount = countWords(readableText);
    const characterCount = countCharacters(readableText, settings.countCharactersWithSpaces);
    const seconds = estimateSeconds(wordCount, settings.wordsPerMinute);

    return {
      ...section,
      wordCount,
      characterCount,
      seconds,
      label: formatReadingTime(wordCount, characterCount, settings)
    };
  });
}

export function summarizeNoteReadingTime(
  markdown: string,
  settings: SectionMeterSettings
): { wordCount: number; characterCount: number; seconds: number; label: string } {
  const readableText = stripMarkdownToReadableText(markdown);
  const wordCount = countWords(readableText);
  const characterCount = countCharacters(readableText, settings.countCharactersWithSpaces);

  return {
    wordCount,
    characterCount,
    seconds: estimateSeconds(wordCount, settings.wordsPerMinute),
    label: formatReadingTime(wordCount, characterCount, settings)
  };
}

export function shouldShowSummary(
  summary: SectionMeterSummary,
  settings: SectionMeterSettings
): boolean {
  if (settings.hideEmptySections && summary.wordCount === 0) {
    return false;
  }

  return summary.wordCount >= Math.max(0, settings.minimumWordCount);
}

export function countReadableWords(markdown: string): number {
  return countWords(stripMarkdownToReadableText(markdown));
}

export function countReadableCharacters(markdown: string, includeSpaces = true): number {
  return countCharacters(stripMarkdownToReadableText(markdown), includeSpaces);
}

function countWords(readable: string): number {
  const words = readable.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu);
  return words?.length ?? 0;
}

function countCharacters(readable: string, includeSpaces: boolean): number {
  const trimmed = readable
    .replace(/^[^\S\r\n]+|[^\S\r\n]+$/gm, "")
    .replace(/[\t\r\n]+/g, " ")
    .trim();
  const countable = includeSpaces ? trimmed : trimmed.replace(/\s/g, "");
  return Array.from(countable).length;
}

export function estimateSeconds(wordCount: number, wordsPerMinute: number): number {
  if (wordCount <= 0) {
    return 0;
  }

  const safeWordsPerMinute = Number.isFinite(wordsPerMinute) && wordsPerMinute > 0
    ? wordsPerMinute
    : DEFAULT_WORDS_PER_MINUTE;

  return Math.max(1, Math.ceil((wordCount / safeWordsPerMinute) * 60));
}

export function formatReadingTime(
  wordCount: number,
  characterCount: number,
  settings: Pick<
    SectionMeterSettings,
    "wordsPerMinute" | "showWords" | "showTiming" | "showCharacters" | "labelSeparator"
  >
): string {
  const wordLabel = `${wordCount} ${wordCount === 1 ? "word" : "words"}`;
  const characterLabel = `${characterCount} ${characterCount === 1 ? "character" : "characters"}`;
  const timeLabel = formatSeconds(estimateSeconds(wordCount, settings.wordsPerMinute));
  const parts: string[] = [];

  if (settings.showWords) {
    parts.push(wordLabel);
  }

  if (settings.showCharacters) {
    parts.push(characterLabel);
  }

  if (settings.showTiming) {
    parts.push(timeLabel);
  }

  return parts.length > 0 ? parts.join(formatSeparator(settings.labelSeparator)) : timeLabel;
}

export function formatSeparator(separator: string): string {
  const character = Array.from(separator.trim())[0] ?? ",";
  return [",", ".", ";", ":"].includes(character) ? `${character} ` : ` ${character} `;
}

export function formatSeconds(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0
    ? Math.ceil(totalSeconds)
    : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function stripMarkdownToReadableText(markdown: string): string {
  let text = removeFrontmatter(markdown);
  text = removeFencedCodeBlocks(text);
  text = text.replace(/[ \t]*<!--[\s\S]*?-->[ \t]*/g, " ");
  text = text.replace(/^ {0,3}<([A-Za-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*$/gm, "");
  text = text.replace(/^ {0,3}<\/?[A-Za-z][^>]*>\s*$/gm, "");
  text = text.replace(/^ {0,3}\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-{3,}:?[ \t]*\|?[ \t]*$/gm, "");
  text = text.replace(/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, "");
  text = text.replace(/[ \t]*!\[\[[^\]]+\]\][ \t]*/g, " ");
  text = text.replace(/[ \t]*!\[[^\]]*]\([^)]*\)[ \t]*/g, " ");
  text = text.replace(/[ \t]*`[^`\n]*`[ \t]*/g, " ");
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)]]/g, "$2");
  text = text.replace(/\[\[([^\]]+)]]/g, "$1");
  text = text.replace(/\[([^\]]+)]\([^)]*\)/g, "$1");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/\s+#+\s*$/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+\[[ xX-]\]\s+/gm, "");
  text = text.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "");
  text = text.replace(/[*_~]/g, "");
  text = text.replace(/[ \t]*\|[ \t]*/g, " ");
  text = text.replace(/[=#\[\]{}]/g, "");
  text = text.replace(/<\/?[^>]+>/g, "");
  return text;
}

function removeFrontmatter(markdown: string): string {
  const lines = splitLines(markdown);
  if (lines[0]?.text.trim() !== "---") {
    return markdown;
  }

  const end = lines.find((line, index) => {
    if (index === 0) {
      return false;
    }

    const trimmed = line.text.trim();
    return trimmed === "---" || trimmed === "...";
  });

  if (!end) {
    return markdown;
  }

  return markdown.slice(end.lineBreakTo);
}

function removeFencedCodeBlocks(markdown: string): string {
  const lines = splitLines(markdown);
  let result = "";
  let lastKeptOffset = 0;
  let fenceStart = -1;
  let inFence: { marker: string; length: number } | null = null;

  for (const line of lines) {
    const fence = parseFence(line.text);
    if (!fence) {
      continue;
    }

    if (!inFence) {
      inFence = fence;
      fenceStart = line.from;
      result += markdown.slice(lastKeptOffset, line.from);
    } else if (fence.marker === inFence.marker && fence.length >= inFence.length) {
      inFence = null;
      result += "\n";
      lastKeptOffset = line.lineBreakTo;
      fenceStart = -1;
    }
  }

  if (inFence && fenceStart >= 0) {
    return result;
  }

  return result + markdown.slice(lastKeptOffset);
}

function splitLines(text: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const lineBreakTo = newlineIndex === -1 ? text.length : newlineIndex + 1;
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const to = lineEnd > lineStart && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;

    lines.push({
      text: text.slice(lineStart, to),
      from: lineStart,
      to,
      lineBreakTo
    });

    if (newlineIndex === -1) {
      break;
    }

    lineStart = newlineIndex + 1;
  }

  return lines;
}

function parseAtxHeading(line: string): Pick<HeadingCandidate, "level" | "title"> | null {
  const match = /^(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
  if (!match) {
    return null;
  }

  const title = match[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
  return {
    level: match[1].length,
    title
  };
}

function parseFence(line: string): { marker: string; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) {
    return null;
  }

  return {
    marker: match[1][0],
    length: match[1].length
  };
}
