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
  showStatusBarNoteStats: boolean;
  showStatusBarSelectionStats: boolean;
  showStatusBarWords: boolean;
  showStatusBarTiming: boolean;
  showStatusBarCharacters: boolean;
  targetOverageWarningPercent: number;
  targetProgressLabelStyle: TargetProgressLabelStyle;
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
  target: WritingTargetProgress | null;
}

export type WritingTargetMetric = "words" | "characters" | "reading-time";
export type TargetProgressLabelStyle = "count" | "percentage";

export interface WritingTarget {
  metric: WritingTargetMetric;
  targetValue: number;
}

export interface WritingTargetProgress extends WritingTarget {
  currentValue: number;
  percent: number;
  isComplete: boolean;
  isOverageWarning: boolean;
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

interface WritingTargetLine extends WritingTarget {
  line: number;
  from: number;
  to: number;
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
  const targets = parseWritingTargetLines(markdown);
  const sections = parseHeadingSections(markdown);

  return sections.map((section) => {
    const content = markdown.slice(section.contentFrom, section.to);
    const readableText = stripMarkdownToReadableText(content);
    const wordCount = countWords(readableText);
    const characterCount = countCharacters(readableText, settings.countCharactersWithSpaces);
    const seconds = estimateSeconds(wordCount, settings.wordsPerMinute);
    const target = findSectionTarget(section, sections, targets);

    return {
      ...section,
      wordCount,
      characterCount,
      seconds,
      label: formatReadingTime(wordCount, characterCount, settings),
      target: target
        ? createWritingTargetProgress(target, wordCount, characterCount, seconds, settings)
        : null
    };
  });
}

export function summarizeNoteReadingTime(
  markdown: string,
  settings: SectionMeterSettings
): {
  wordCount: number;
  characterCount: number;
  seconds: number;
  label: string;
  target: WritingTargetProgress | null;
} {
  const readableText = stripMarkdownToReadableText(markdown);
  const wordCount = countWords(readableText);
  const characterCount = countCharacters(readableText, settings.countCharactersWithSpaces);
  const noteTarget = findNoteTarget(markdown, parseHeadingSections(markdown));

  return {
    wordCount,
    characterCount,
    seconds: estimateSeconds(wordCount, settings.wordsPerMinute),
    label: formatReadingTime(wordCount, characterCount, settings),
    target: noteTarget
      ? createWritingTargetProgress(
        noteTarget,
        wordCount,
        characterCount,
        estimateSeconds(wordCount, settings.wordsPerMinute),
        settings
      )
      : null
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

export function parseWritingTargetLine(line: string): WritingTarget | null {
  const match = /^ {0,3}Target:\s*(.+?)\s*$/i.exec(line);
  if (!match) {
    return null;
  }

  const value = match[1].trim();
  const countTarget = parseCountWritingTarget(value);
  if (countTarget) {
    return countTarget;
  }

  return parseReadingTimeWritingTarget(value);
}

function countWords(readable: string): number {
  const words = readable.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu);
  return words?.length ?? 0;
}

function countCharacters(readable: string, includeSpaces: boolean): number {
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
  text = removeWritingTargetLines(text);
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

function parseWritingTargetLines(markdown: string): WritingTargetLine[] {
  const lines = splitLines(markdown);
  const targets: WritingTargetLine[] = [];
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

    const target = parseWritingTargetLine(line.text);
    if (!target) {
      continue;
    }

    targets.push({
      ...target,
      line: index,
      from: line.from,
      to: line.to
    });
  }

  return targets;
}

function findNoteTarget(markdown: string, sections: HeadingSection[]): WritingTarget | null {
  const firstHeadingFrom = sections[0]?.from ?? markdown.length;
  return parseWritingTargetLines(markdown)
    .find((target) => target.from < firstHeadingFrom) ?? null;
}

function findSectionTarget(
  section: HeadingSection,
  sections: HeadingSection[],
  targets: WritingTargetLine[]
): WritingTarget | null {
  return targets.find((target) => {
    if (target.from < section.contentFrom || target.from >= section.to) {
      return false;
    }

    const owningSection = findNearestHeadingSectionBefore(target.from, sections);
    return owningSection?.from === section.from;
  }) ?? null;
}

function findNearestHeadingSectionBefore(
  position: number,
  sections: HeadingSection[]
): HeadingSection | null {
  for (let index = sections.length - 1; index >= 0; index--) {
    if (sections[index].from < position) {
      return sections[index];
    }
  }

  return null;
}

function createWritingTargetProgress(
  target: WritingTarget,
  wordCount: number,
  characterCount: number,
  seconds: number,
  settings: Pick<SectionMeterSettings, "targetOverageWarningPercent" | "targetProgressLabelStyle">
): WritingTargetProgress {
  const currentValue = getTargetCurrentValue(target.metric, wordCount, characterCount, seconds);
  const percent = target.targetValue > 0
    ? (currentValue / target.targetValue) * 100
    : 0;
  const overageThreshold = target.targetValue * (settings.targetOverageWarningPercent / 100);

  return {
    ...target,
    currentValue,
    percent,
    isComplete: currentValue >= target.targetValue,
    isOverageWarning: currentValue >= overageThreshold,
    label: formatWritingTargetProgressLabel(
      target.metric,
      currentValue,
      target.targetValue,
      percent,
      settings.targetProgressLabelStyle
    )
  };
}

function getTargetCurrentValue(
  metric: WritingTargetMetric,
  wordCount: number,
  characterCount: number,
  seconds: number
): number {
  if (metric === "words") {
    return wordCount;
  }

  if (metric === "characters") {
    return characterCount;
  }

  return seconds;
}

function formatWritingTargetProgressLabel(
  metric: WritingTargetMetric,
  currentValue: number,
  targetValue: number,
  percent: number,
  labelStyle: TargetProgressLabelStyle
): string {
  if (labelStyle === "percentage") {
    return `${Math.round(percent)}%`;
  }

  if (metric === "reading-time") {
    return `${formatSeconds(currentValue)} / ${formatSeconds(targetValue)}`;
  }

  const unit = metric === "words" ? "w" : "c";
  return `${currentValue} / ${targetValue} ${unit}`;
}

function parseCountWritingTarget(value: string): WritingTarget | null {
  const match = /^([0-9][0-9,]*)\s*(words?|chars?|characters?)$/i.exec(value);
  if (!match) {
    return null;
  }

  const targetValue = parseTargetInteger(match[1]);
  if (targetValue <= 0) {
    return null;
  }

  return {
    metric: /^words?$/i.test(match[2]) ? "words" : "characters",
    targetValue
  };
}

function parseReadingTimeWritingTarget(value: string): WritingTarget | null {
  const normalized = value.toLowerCase().replace(/,/g, "").trim();
  const match = /^(\d+)\s*(?:m|min|mins|minute|minutes)(?:\s+(\d+)\s*(?:s|sec|secs|second|seconds))?$/.exec(normalized);
  if (!match) {
    return null;
  }

  const minutes = Number(match[1]);
  const seconds = match[2] ? Number(match[2]) : 0;
  const targetValue = (minutes * 60) + seconds;

  return targetValue > 0
    ? {
      metric: "reading-time",
      targetValue
    }
    : null;
}

function parseTargetInteger(value: string): number {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isInteger(parsed) ? parsed : 0;
}

function removeWritingTargetLines(markdown: string): string {
  const lines = splitLines(markdown);
  let result = "";

  for (const line of lines) {
    if (!parseWritingTargetLine(line.text)) {
      result += markdown.slice(line.from, line.lineBreakTo);
    }
  }

  return result;
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
