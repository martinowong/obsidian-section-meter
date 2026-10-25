import { MarkdownRenderChild, type MarkdownPostProcessorContext, type MarkdownSectionInformation } from "obsidian";
import { shouldShowSummary, type SectionMeterSettings, type SectionMeterSummary } from "./readingTime";

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/** One rendered Markdown chunk. Obsidian owns this child's lifetime. */
export class ReadingViewStats extends MarkdownRenderChild {
  private badges = new Map<HTMLElement, { element: HTMLElement; key: string }>();

  constructor(
    containerEl: HTMLElement,
    readonly context: MarkdownPostProcessorContext,
    private readonly getSettings: () => SectionMeterSettings,
    private readonly getSections: (docId: string, markdown: string) => Map<number, SectionMeterSummary>,
    private readonly createBadge: (summary: SectionMeterSummary, getSource: () => MarkdownSectionInformation | null) => HTMLElement,
    private readonly onAttach: (child: ReadingViewStats) => void,
    private readonly onDetach: (child: ReadingViewStats) => void
  ) {
    super(containerEl);
  }

  onload(): void {
    this.onAttach(this);
    this.refresh();
  }

  refresh(): void {
    const settings = this.getSettings();
    const headings = Array.from(this.containerEl.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
    if (this.containerEl.matches(HEADING_SELECTOR)) headings.unshift(this.containerEl);
    const retained = new Set<HTMLElement>();

    for (const heading of headings) {
      // Source lines, not rendered text, distinguish identical heading names.
      // The source also excludes code, comments and target lines from counts.
      const info = this.context.getSectionInfo(heading);
      const summary = settings.enabled && settings.showHeadingStats && info
        ? this.getSections(this.context.docId, info.text).get(info.lineStart)
        : undefined;
      if (!summary || summary.level !== Number(heading.tagName.slice(1))
        || (!summary.target && !shouldShowSummary(summary, settings))) continue;
      retained.add(heading);
      const key = JSON.stringify([summary.label, summary.wordCount, summary.characterCount,
        summary.seconds, summary.target]);
      const previous = this.badges.get(heading);
      if (previous?.key === key && previous.element.parentElement === heading) continue;
      previous?.element.remove();
      const element = this.createBadge(summary, () => this.context.getSectionInfo(heading));
      // A separate, non-editable UI node; native links, data-heading and folding
      // controls remain untouched. Statistics never come from this DOM text.
      heading.appendChild(element);
      this.badges.set(heading, { element, key });
    }

    for (const [heading, badge] of this.badges) {
      if (!retained.has(heading)) {
        badge.element.remove();
        this.badges.delete(heading);
      }
    }
  }

  onunload(): void {
    for (const badge of this.badges.values()) badge.element.remove();
    this.badges.clear();
    this.onDetach(this);
  }
}

export function containsReadingViewHeadings(element: HTMLElement): boolean {
  return element.matches(HEADING_SELECTOR) || !!element.querySelector(HEADING_SELECTOR);
}
