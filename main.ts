import { Compartment, EditorState, Extension, MapMode, RangeSetBuilder, Text } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  PluginValue,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from "@codemirror/view";
import {
  App,
  Editor,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TextComponent,
  editorLivePreviewField,
  setIcon
} from "obsidian";
import type {
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionItem,
  MarkdownSectionInformation
} from "obsidian";
import {
  SectionMeterSettings,
  SectionMeterSummary,
  NoteMeterSummary,
  ReadingTimeSummaries,
  LegacyLabelStyle,
  WritingTarget,
  WritingTargetMetric,
  WritingTargetProgress,
  WritingTargetLine,
  WritingTargetScope,
  createWritingTargetTextEdit,
  formatReadingTime,
  formatSeconds,
  formatWritingTargetCountLabel,
  formatWritingTargetLine,
  getNextTargetProgressLabelStyle,
  getActiveSectionTargetAtPosition,
  getActiveSectionTargetSummaryAtPosition,
  estimateSeconds,
  parseWritingTargetLine,
  parseWritingTargetLines,
  shouldShowSummary,
  summarizeNoteReadingTime,
  summarizeReadingTimes,
  summarizeSectionReadingTimes
} from "./src/readingTime";
import {
  documentChangesMayAffectHeadings,
  selectionIntersectsHeading
} from "./src/headingDecorations";
import { TargetCompletionTracker, type TargetCompletion } from "./src/targetCompletion";
import { containsReadingViewHeadings, ReadingViewStats } from "./src/readingView";

declare const __SECTION_METER_BUILD_LABEL__: string;

const DEFAULT_SETTINGS: SectionMeterSettings = {
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
  targetProgressLabelStyle: "count",
  targetPresets: "250 words, 500 words, 1000 words, 10m",
  notifyOnTargetReached: false,
  classicTargetColors: false,
  showTargetChips: true,
  mobileStickySectionMeter: false,
  mobileMeterPosition: "bottom",
  previewSticky: true
};
const CLASSIC_TARGET_COLORS_CLASS = "section-meter-classic-target-colors";
const MIN_WORDS_PER_MINUTE = 100;
const MAX_WORDS_PER_MINUTE = 500;
const WORDS_PER_MINUTE_STEP = 10;
const MIN_TARGET_OVERAGE_WARNING_PERCENT = 100;
const MAX_TARGET_OVERAGE_WARNING_PERCENT = 200;
const TARGET_OVERAGE_WARNING_PERCENT_STEP = 5;
const DOCUMENT_STATS_UPDATE_DELAY_MS = 120;
const SELECTION_BADGE_UPDATE_DELAY_MS = 220;
const SELECTION_STATS_INTERVAL_MS = 50;
const TITLE_BADGE_UPDATE_DELAY_MS = DOCUMENT_STATS_UPDATE_DELAY_MS + 40;
const PREVIEW_WORD_COUNT = 640;
const PREVIEW_TARGET_WORD_COUNT = 163;
const PREVIEW_TARGET_WORDS = 250;
const PREVIEW_CHARACTER_COUNT = 3200;

type StoredSettings = Partial<Record<keyof SectionMeterSettings, unknown>> & {
  labelStyle?: unknown;
};

export default class SectionMeterPlugin extends Plugin {
  settings: SectionMeterSettings = DEFAULT_SETTINGS;
  private extensionCompartment = new Compartment();
  private statusBarItem: HTMLElement | null = null;
  private lastStatusBarRenderKey = "hidden";
  private titleBadgeUpdateTimers = new Map<MarkdownView, number>();
  private unloaded = false;
  private targetColorDocuments = new Set<Document>();
  private readingViewChildren = new Set<ReadingViewStats>();
  private readingViewChunks = new WeakMap<HTMLElement, ReadingViewStats>();
  private readingViewContent = new WeakMap<MarkdownView, { markdown: string; settingsKey: string }>();
  private titleSummaryCache = new WeakMap<MarkdownView, { markdown: string; settingsKey: string; summary: NoteMeterSummary }>();
  private readingViewRefreshFrame: number | null = null;
  private readingViewCache = new Map<string, {
    markdown: string;
    settingsKey: string;
    sections: Map<number, SectionMeterSummary>;
  }>();
  private readingTimeCache = new WeakMap<EditorView, {
    doc: Text;
    settingsKey: string;
    summaries: ReadingTimeSummaries;
  }>();

  async onload() {
    this.unloaded = false;
    await this.loadSettings();
    this.applyTargetColorStyle(activeDocument);
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.classList.add("section-meter-status-bar");
    this.clearStatusBar();

    this.registerEditorExtension(
      this.extensionCompartment.of(createSectionMeterExtension(
        () => this.settings,
        (status) => this.updateStatusBar(status),
        (position) => this.updateMobileMeterPosition(position),
        (view, scope, position) => this.openMobileTargetEditor(view, scope, position),
        (view, summaries) => this.cacheReadingTimes(view, summaries),
        (view) => this.isActiveEditor(view),
        (view, reached) => this.notifyReachedTargets(view, reached),
        (view) => this.getMarkdownViewForEditor(view)?.file?.path ?? null
      ))
    );
    this.addSettingTab(new SectionMeterSettingTab(this.app, this));
    this.registerWritingTargetCommands();
    this.registerStatsDisplayCommands();
    this.registerMarkdownPostProcessor((element, context) => {
      if (this.unloaded) return;
      if (containsReadingViewHeadings(element)) {
        const existing = this.readingViewChunks.get(element);
        if (existing && existing.context.docId === context.docId
          && existing.context.sourcePath === context.sourcePath) {
          existing.refresh();
        } else {
          existing?.unload();
          context.addChild(new ReadingViewStats(
            element, context, () => this.settings,
            (docId, markdown) => this.getReadingViewSections(docId, markdown),
            (summary, getSource) => createReadingTimeBadge(summary.label, summary.wordCount,
              summary.characterCount, summary.seconds, summary.target,
              "section-meter-reading-badge", true, "Heading section stats",
              () => this.getReadingViewTargetActions(context.sourcePath, getSource)),
            (child) => {
              this.readingViewChildren.add(child);
              this.readingViewChunks.set(child.containerEl, child);
            },
            (child) => {
              this.readingViewChildren.delete(child);
              if (this.readingViewChunks.get(child.containerEl) === child) {
                this.readingViewChunks.delete(child.containerEl);
              }
              if (![...this.readingViewChildren].some((other) => other.context.docId === child.context.docId)) {
                this.readingViewCache.delete(child.context.docId);
              }
            }
          ));
        }
      }
      // A prose-only chunk can change counts on already-rendered headings.
      this.scheduleReadingViewRefresh();
    });
    this.registerEvent(this.app.vault.on("modify", (file) => {
      const relevant = [...this.readingViewChildren].some((child) => child.context.sourcePath === file.path)
        || this.app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view instanceof MarkdownView
          && leaf.view.getMode() === "preview" && leaf.view.file?.path === file.path);
      if (relevant) this.scheduleReadingViewRefresh();
    }));
    this.registerEvent(
      this.app.workspace.on("window-open", (workspaceWindow) => {
        this.applyTargetColorStyle(workspaceWindow.doc);
      })
    );
    this.registerEvent(
      this.app.workspace.on("window-close", (workspaceWindow) => {
        this.targetColorDocuments.delete(workspaceWindow.doc);
      })
    );
    this.registerEvent(
      // Themes and snippets can change the title's spacing, which badges copy when created.
      this.app.workspace.on("css-change", () => this.refreshTitleBadges(true))
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.refreshTitleBadges();
        this.refreshStatusBarFromActiveView();
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshActiveEditorUI();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.refreshTitleBadges();
        this.refreshActiveEditorUI();
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        if (this.settings.enabled && info instanceof MarkdownView) {
          this.scheduleTitleBadgeRefresh(info);
        }
      })
    );
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
        if (leaf.view instanceof MarkdownView && leaf.view.getMode() === "preview") {
          leaf.view.previewMode.rerender(true);
        }
      });
      this.refreshTitleBadges();
      this.refreshStatusBarFromActiveView();
    });
  }

  onunload() {
    this.unloaded = true;
    for (const timer of this.titleBadgeUpdateTimers.values()) window.clearTimeout(timer);
    this.titleBadgeUpdateTimers.clear();
    if (this.readingViewRefreshFrame !== null) window.cancelAnimationFrame(this.readingViewRefreshFrame);
    this.readingViewRefreshFrame = null;
    for (const child of [...this.readingViewChildren]) child.unload();
    this.readingViewCache.clear();
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (leaf.view instanceof MarkdownView) removeTitleBadge(leaf.view.containerEl);
    });
    this.clearStatusBar();
    this.applyTargetColorStyle();
    this.targetColorDocuments.clear();
  }

  async loadSettings() {
    const loadedSettings: unknown = await this.loadData();
    this.settings = normalizeSettings(readStoredSettings(loadedSettings));
  }

  async saveSettings({ refreshStats = true }: { refreshStats?: boolean } = {}) {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
    this.applyTargetColorStyle();
    if (this.unloaded || !refreshStats) return;
    this.refreshEditorExtensions();
    this.refreshReadingViewStats();
    this.refreshTitleBadges();
    this.refreshStatusBarFromActiveView();
  }

  /** Each window has its own body, so popouts need the colour class too. */
  private applyTargetColorStyle(doc?: Document): void {
    if (doc) this.targetColorDocuments.add(doc);
    for (const targetDocument of this.targetColorDocuments) {
      targetDocument.body.classList.toggle(
        CLASSIC_TARGET_COLORS_CLASS,
        !this.unloaded && this.settings.classicTargetColors
      );
    }
  }

  private updateMobileMeterPosition(position: SectionMeterSettings["mobileMeterPosition"]): void {
    if (this.settings.mobileMeterPosition === position) {
      return;
    }

    this.settings.mobileMeterPosition = position;
    this.refreshActiveEditorUI();
    void this.saveSettings({ refreshStats: false });
  }

  private isActiveEditor(editorView: EditorView): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return !!view && getEditorView(view) === editorView;
  }

  refreshMobileMeterPlacement(): void {
    this.refreshActiveEditorUI();
  }

  private getMarkdownViewForEditor(editorView: EditorView): MarkdownView | undefined {
    return this.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view)
      .find((view): view is MarkdownView => view instanceof MarkdownView && getEditorView(view) === editorView);
  }

  private refreshActiveEditorUI(): void {
    if (this.unloaded) return;
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (leaf.view instanceof MarkdownView) getEditorView(leaf.view)?.dispatch({});
    });
    this.refreshStatusBarFromActiveView();
  }

  private openMobileTargetEditor(editorView: EditorView, scope: WritingTargetScope, position: number): void {
    const view = this.getMarkdownViewForEditor(editorView);
    if (!view) {
      return;
    }

    this.openWritingTargetModal(view.editor, scope, position);
  }

  private getReadingViewTargetActions(
    sourcePath: string,
    getSource: () => MarkdownSectionInformation | null
  ): BadgeTargetActions | null {
    const source = getSource();
    const file = this.app.vault.getFileByPath(sourcePath);
    const summary = source && summarizeSectionReadingTimes(source.text, this.settings)
      .find((section) => section.line === source.lineStart);
    if (this.unloaded || !source || !file || !summary?.target) return null;

    const apply = async (target: WritingTarget | null): Promise<void> => {
      if (this.unloaded) return;
      try {
        await this.app.vault.process(file, (markdown) => {
          if (markdown !== source.text || file.path !== sourcePath) {
            new Notice("The note changed. Please tap the updated target again.");
            return markdown;
          }
          const edit = createWritingTargetTextEdit(markdown, "section", summary.from, target);
          return edit ? markdown.slice(0, edit.from) + edit.text + markdown.slice(edit.to) : markdown;
        });
      } catch {
        new Notice("The target could not be updated. Please try again.");
      }
    };
    return {
      edit: () => new WritingTargetModal(this.app, "section", summary.target,
        getWritingTargetPresets(this.settings.targetPresets), (target) => { void apply(target); }).open(),
      remove: () => apply(null)
    };
  }

  private registerWritingTargetCommands() {
    this.addCommand({
      id: "set-note-writing-target",
      name: "Set or edit whole-note writing target",
      editorCallback: (editor) => this.openWritingTargetModal(editor, "note")
    });
    this.addCommand({
      id: "set-section-writing-target",
      name: "Set or edit current-section writing target",
      editorCallback: (editor) => this.openWritingTargetModal(editor, "section")
    });
    this.addCommand({
      id: "remove-note-writing-target",
      name: "Remove whole-note writing target",
      editorCallback: (editor) => this.removeWritingTarget(editor, "note")
    });
    this.addCommand({
      id: "remove-section-writing-target",
      name: "Remove current-section writing target",
      editorCallback: (editor) => this.removeWritingTarget(editor, "section")
    });
  }

  private registerStatsDisplayCommands() {
    this.addCommand({
      id: "cycle-target-progress-label",
      name: "Cycle target progress label",
      callback: () => {
        void this.cycleTargetProgressLabelStyle();
      }
    });
    this.addCommand({
      id: "toggle-plugin",
      name: "Toggle plugin on/off",
      callback: () => {
        void this.setPluginEnabled(!this.settings.enabled);
      }
    });
    this.addCommand({
      id: "show-stats-in-status-bar-only",
      name: "Toggle heading and title stats",
      callback: () => {
        const inlineStatsVisible = this.settings.showHeadingStats
          && this.settings.showInlineTitleStats;
        void this.setStatsDisplay({
          headings: !inlineStatsVisible,
          inlineTitle: !inlineStatsVisible,
          statusBarNote: this.settings.showStatusBarNoteStats,
          statusBarSelection: this.settings.showStatusBarSelectionStats
        });
      }
    });
    this.addCommand({
      id: "hide-status-bar-stats",
      name: "Toggle status bar stats",
      callback: () => {
        const statusBarStatsVisible = this.settings.showStatusBarNoteStats
          || this.settings.showStatusBarSelectionStats;
        void this.setStatsDisplay({
          headings: this.settings.showHeadingStats,
          inlineTitle: this.settings.showInlineTitleStats,
          statusBarNote: !statusBarStatsVisible,
          statusBarSelection: !statusBarStatsVisible
        });
      }
    });
  }

  private async cycleTargetProgressLabelStyle(): Promise<void> {
    const nextStyle = getNextTargetProgressLabelStyle(
      this.settings.targetProgressLabelStyle
    );
    this.settings.targetProgressLabelStyle = nextStyle;
    await this.saveSettings();

    const label = {
      count: "count",
      percentage: "percentage",
      remaining: "remaining amount"
    }[nextStyle];
    new Notice(`Target progress now shows ${label}.`);
  }

  private async setPluginEnabled(enabled: boolean): Promise<void> {
    this.settings.enabled = enabled;
    await this.saveSettings();
    new Notice(`Section Writing Stats ${enabled ? "enabled" : "disabled"}.`);
  }

  private async setStatsDisplay(display: {
    headings: boolean;
    inlineTitle: boolean;
    statusBarNote: boolean;
    statusBarSelection: boolean;
  }): Promise<void> {
    this.settings.showHeadingStats = display.headings;
    this.settings.showInlineTitleStats = display.inlineTitle;
    this.settings.showStatusBarNoteStats = display.statusBarNote;
    this.settings.showStatusBarSelectionStats = display.statusBarSelection;
    await this.saveSettings();
  }

  private openWritingTargetModal(editor: Editor, scope: WritingTargetScope, position?: number) {
    const context = getWritingTargetCommandContext(editor, scope, this.settings, position);
    const owner = this.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view)
      .find((view): view is MarkdownView => view instanceof MarkdownView && view.editor === editor);
    const ownerPath = owner?.file?.path;
    if (!context) {
      new Notice("Place the cursor inside a heading section first.");
      return;
    }

    new WritingTargetModal(
      this.app,
      scope,
      context.existingTarget,
      getWritingTargetPresets(this.settings.targetPresets),
      (target) => {
        // Keep the owner chosen when the modal opened, not the cursor's later
        // location. Refuse stale offsets rather than modifying another section.
        if (editor.getValue() !== context.markdown || (owner && owner.file?.path !== ownerPath)) {
          new Notice("The note changed. Please open the target editor again.");
          return;
        }

        const edit = createWritingTargetTextEdit(
          context.markdown,
          scope,
          context.position,
          target
        );
        if (!edit) {
          new Notice("The writing target could not be added.");
          return;
        }

        editor.replaceRange(
          edit.text,
          editor.offsetToPos(edit.from),
          editor.offsetToPos(edit.to)
        );
      }
    ).open();
  }

  private notifyReachedTargets(view: EditorView, reached: TargetCompletion[]): void {
    if (this.unloaded || !this.settings.notifyOnTargetReached || !this.isActiveEditor(view)) return;
    for (const { label, target } of reached) {
      new Notice(`${label} target reached — ${formatWritingTargetCountLabel(target)}.`);
    }
  }

  private removeWritingTarget(editor: Editor, scope: WritingTargetScope) {
    const context = getWritingTargetCommandContext(editor, scope, this.settings);
    if (!context) {
      new Notice("Place the cursor inside a heading section first.");
      return;
    }

    const edit = createWritingTargetTextEdit(
      context.markdown,
      scope,
      context.position,
      null
    );
    if (!edit) {
      const targetScope = scope === "note" ? "whole note" : "current section";
      new Notice(`No writing target exists for the ${targetScope}.`);
      return;
    }

    editor.replaceRange(
      edit.text,
      editor.offsetToPos(edit.from),
      editor.offsetToPos(edit.to)
    );
  }

  private refreshEditorExtensions() {
    const extension = createSectionMeterExtension(
      () => this.settings,
      (status) => this.updateStatusBar(status),
      (position) => this.updateMobileMeterPosition(position),
      (view, scope, position) => this.openMobileTargetEditor(view, scope, position),
      (view, summaries) => this.cacheReadingTimes(view, summaries),
      (view) => this.isActiveEditor(view),
      (view, reached) => this.notifyReachedTargets(view, reached),
      (view) => this.getMarkdownViewForEditor(view)?.file?.path ?? null
    );

    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) {
        return;
      }

      const editorView = getEditorView(leaf.view);
      editorView?.dispatch({
        effects: this.extensionCompartment.reconfigure(extension)
      });
    });
  }

  private refreshTitleBadges(force = false) {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (leaf.view instanceof MarkdownView) {
        this.refreshTitleBadge(leaf.view, force);
      }
    });
  }

  private getReadingViewSections(docId: string, markdown: string): Map<number, SectionMeterSummary> {
    const settingsKey = getReadingTimeSettingsKey(this.settings);
    const cached = this.readingViewCache.get(docId);
    if (cached?.markdown === markdown && cached.settingsKey === settingsKey) return cached.sections;
    const sections = new Map(summarizeSectionReadingTimes(markdown, this.settings)
      .map((summary) => [summary.line, summary]));
    this.readingViewCache.set(docId, { markdown, settingsKey, sections });
    return sections;
  }

  private refreshReadingViewStats(): void {
    if (this.unloaded) return;
    for (const child of this.readingViewChildren) child.refresh();
  }

  private scheduleReadingViewRefresh(): void {
    if (this.unloaded || this.readingViewRefreshFrame !== null) return;
    this.readingViewRefreshFrame = window.requestAnimationFrame(() => {
      this.readingViewRefreshFrame = null;
      if (this.unloaded) return;
      this.refreshReadingViewStats();
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const settingsKey = getReadingTimeSettingsKey(this.settings);
      this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
        if (leaf.view instanceof MarkdownView && leaf.view.getMode() === "preview") {
          const markdown = leaf.view.getViewData();
          const cached = this.readingViewContent.get(leaf.view);
          const titleMissing = this.settings.enabled && this.settings.showInlineTitleStats
            && !!leaf.view.containerEl.querySelector(".inline-title")
            && !leaf.view.containerEl.querySelector(".section-meter-title-badge");
          // Virtualized chunks are rendered while scrolling. Do not recount the
          // whole note or replace its title badge when only the viewport changed.
          if (cached?.markdown === markdown && cached.settingsKey === settingsKey && !titleMissing) return;
          this.readingViewContent.set(leaf.view, { markdown, settingsKey });
          this.refreshTitleBadge(leaf.view);
          if (leaf.view === activeView) this.refreshStatusBarFromActiveView();
        }
      });
    });
  }

  private refreshStatusBarFromActiveView() {
    if (this.unloaded || !this.settings.enabled) {
      this.clearStatusBar();
      return;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      this.clearStatusBar();
      return;
    }

    const editorView = getEditorView(activeView);
    if (editorView && activeView.getMode() !== "preview") {
      const summaries = this.getCachedReadingTimes(editorView)
        ?? summarizeReadingTimes(editorView.state.doc.toString(), this.settings);
      this.updateStatusBar(getStatusBarStats(
        editorView,
        this.settings,
        summaries.sections,
        summaries.note
      ));
      return;
    }

    const noteStats = summarizeNoteReadingTime(activeView.getViewData(), this.settings);
    this.updateStatusBar({
      note: noteStats,
      selection: null,
      sectionTarget: null
    });
  }

  private cacheReadingTimes(view: EditorView, summaries: ReadingTimeSummaries) {
    this.readingTimeCache.set(view, {
      doc: view.state.doc,
      settingsKey: getReadingTimeSettingsKey(this.settings),
      summaries
    });
  }

  private getCachedReadingTimes(view: EditorView): ReadingTimeSummaries | null {
    const cached = this.readingTimeCache.get(view);
    return cached?.doc === view.state.doc && cached.settingsKey === getReadingTimeSettingsKey(this.settings)
      ? cached.summaries
      : null;
  }

  private scheduleTitleBadgeRefresh(markdownView: MarkdownView) {
    if (this.unloaded) return;
    const previous = this.titleBadgeUpdateTimers.get(markdownView);
    if (previous !== undefined) window.clearTimeout(previous);

    const timer = window.setTimeout(() => {
      this.titleBadgeUpdateTimers.delete(markdownView);
      this.refreshTitleBadge(markdownView);
    }, TITLE_BADGE_UPDATE_DELAY_MS);
    this.titleBadgeUpdateTimers.set(markdownView, timer);
  }

  private refreshTitleBadge(markdownView: MarkdownView, force = false) {
    if (this.unloaded) return;
    const container = markdownView.containerEl;
    const titleEl = container.querySelector<HTMLElement>(".inline-title");
    const titleRow = titleEl?.parentElement;
    if (!this.settings.enabled || !this.settings.showInlineTitleStats || !titleEl || !titleRow) {
      removeTitleBadge(container);
      return;
    }

    const summary = this.getTitleSummary(markdownView);
    const renderKey = JSON.stringify([summary.label, summary.wordCount, summary.characterCount, summary.seconds,
      summary.target?.label, summary.target && getTargetProgressStateClass(summary.target),
      summary.target && Math.round(summary.target.percent)]);
    const existing = titleEl.nextElementSibling;
    // Typing pauses and layout changes often leave the numbers unchanged; skip rebuilding then.
    if (!force && existing instanceof HTMLElement
      && existing.classList.contains("section-meter-title-badge") && existing.dataset.renderKey === renderKey) {
      return;
    }

    removeTitleBadge(container);
    const badge = createReadingTimeBadge(
      summary.label,
      summary.wordCount,
      summary.characterCount,
      summary.seconds,
      summary.target,
      "section-meter-title-badge",
      false,
      "Whole note stats"
    );
    badge.dataset.renderKey = renderKey;
    // Never put UI inside `.inline-title`: Obsidian serializes that element as
    // the note title, including `contenteditable=false` children. An in-flow
    // sibling reserves its own height without changing the title's alignment.
    const titleGap = titleEl.ownerDocument.defaultView?.getComputedStyle(titleEl).marginBottom;
    if (titleGap) badge.style.marginBlockEnd = titleGap;
    titleRow.addClass("section-meter-title-row");
    badge.setAttribute("aria-hidden", "true");
    titleEl.insertAdjacentElement("afterend", badge);
  }

  /** Whole-note stats for a title badge: the editor's cached counts, or a count kept per unchanged note. */
  private getTitleSummary(markdownView: MarkdownView): NoteMeterSummary {
    const editorView = getEditorView(markdownView);
    const cached = editorView && markdownView.getMode() !== "preview"
      ? this.getCachedReadingTimes(editorView)?.note
      : null;
    if (cached) return cached;

    const markdown = markdownView.getViewData();
    const settingsKey = getReadingTimeSettingsKey(this.settings);
    const previous = this.titleSummaryCache.get(markdownView);
    if (previous?.markdown === markdown && previous.settingsKey === settingsKey) return previous.summary;

    const summary = summarizeNoteReadingTime(markdown, this.settings);
    this.titleSummaryCache.set(markdownView, { markdown, settingsKey, summary });
    return summary;
  }

  private updateStatusBar(status: StatusBarStats | null) {
    if (this.unloaded) return;
    if (!this.statusBarItem) {
      return;
    }

    const hasVisibleStatus = Boolean(
      (this.settings.showStatusBarNoteStats && status?.note)
      || (this.settings.showStatusBarSelectionStats && status?.selection)
      || status?.sectionTarget
    );
    const renderKey = hasVisibleStatus
      ? createStatusBarRenderKey(status, this.settings)
      : "hidden";
    if (renderKey === this.lastStatusBarRenderKey) {
      return;
    }
    this.lastStatusBarRenderKey = renderKey;

    this.statusBarItem.empty();
    const partLabels: string[] = [];
    if (this.settings.showStatusBarNoteStats && status?.note) {
      const notePart = createStatusBarStatsEl("Note", status.note, this.settings);
      this.statusBarItem.appendChild(notePart);
      partLabels.push(`Note: ${formatStatusBarStats(status.note, this.settings)}`);
    }

    if (this.settings.showStatusBarSelectionStats && status?.selection) {
      if (partLabels.length > 0) {
        this.statusBarItem.appendChild(createStatusBarSeparatorEl());
      }

      const selectionPart = createStatusBarStatsEl("Selection", status.selection, this.settings);
      this.statusBarItem.appendChild(selectionPart);
      partLabels.push(`Selection: ${formatStatusBarStats(status.selection, this.settings)}`);
    }

    if (status?.sectionTarget) {
      if (partLabels.length > 0) {
        this.statusBarItem.appendChild(createStatusBarSeparatorEl());
      }

      const targetPart = createStatusBarTargetEl(status.sectionTarget);
      this.statusBarItem.appendChild(targetPart);
      partLabels.push(formatTargetProgressForStatus(status.sectionTarget));
    }

    if (partLabels.length === 0) {
      this.clearStatusBar();
      return;
    }

    this.statusBarItem.setAttribute(
      "aria-label",
      partLabels.join(". ")
    );
    this.statusBarItem.setAttribute("title", "Section Writing Stats");
    this.statusBarItem.classList.remove("section-meter-status-bar-hidden");
  }

  private clearStatusBar() {
    if (!this.statusBarItem) {
      return;
    }

    this.statusBarItem.textContent = "";
    this.statusBarItem.removeAttribute("aria-label");
    this.statusBarItem.removeAttribute("title");
    this.statusBarItem.classList.add("section-meter-status-bar-hidden");
    this.lastStatusBarRenderKey = "hidden";
  }
}

interface WritingTargetCommandContext {
  markdown: string;
  position: number;
  existingTarget: WritingTarget | null;
}

function getWritingTargetCommandContext(
  editor: Editor,
  scope: WritingTargetScope,
  settings: SectionMeterSettings,
  requestedPosition?: number
): WritingTargetCommandContext | null {
  const markdown = editor.getValue();
  const position = requestedPosition ?? editor.posToOffset(editor.getCursor());
  if (scope === "note") {
    return {
      markdown,
      position,
      existingTarget: summarizeNoteReadingTime(markdown, settings).target
    };
  }

  const section = findSectionSummaryAtPosition(
    summarizeSectionReadingTimes(markdown, settings),
    position,
    markdown.length
  );
  return section
    ? {
      markdown,
      position,
      existingTarget: section.target
    }
    : null;
}

function findSectionSummaryAtPosition(
  summaries: SectionMeterSummary[],
  position: number,
  documentEnd: number
): SectionMeterSummary | null {
  for (let index = summaries.length - 1; index >= 0; index--) {
    const summary = summaries[index];
    if (position >= summary.from
      && (position < summary.to || (position === documentEnd && summary.to === documentEnd))) {
      return summary;
    }
  }

  return null;
}

class WritingTargetModal extends Modal {
  constructor(
    app: App,
    private readonly targetScope: WritingTargetScope,
    private readonly existingTarget: WritingTarget | null,
    private readonly presets: WritingTarget[],
    private readonly onSubmitTarget: (target: WritingTarget) => void
  ) {
    super(app);
  }

  onOpen() {
    const scopeLabel = this.targetScope === "note" ? "whole note" : "current section";
    this.setTitle(`${this.existingTarget ? "Edit" : "Set"} ${scopeLabel} target`);
    this.contentEl.empty();

    const formEl = this.contentEl.createEl("form");
    let metric: WritingTargetMetric = this.existingTarget?.metric ?? "words";
    let amountInput: TextComponent | null = null;
    let metricDropdown: {
      setValue(value: string): unknown;
    } | null = null;

    const updateAmountInput = () => {
      if (amountInput === null) {
        return;
      }

      amountInput.setPlaceholder(metric === "reading-time" ? "3m, 2m 30s, or 45s" : "250");
      // Text keyboards on mobile, so units such as 30s or 250w can be typed.
      amountInput.inputEl.inputMode = "text";
    };

    new Setting(formEl)
      .setName("Measure")
      .addDropdown((dropdown) => {
        metricDropdown = dropdown;
        return dropdown
          .addOption("words", "Words")
          .addOption("characters", "Characters")
          .addOption("reading-time", "Reading time")
          .setValue(metric)
          .onChange((value) => {
            metric = value as WritingTargetMetric;
            updateAmountInput();
          });
      });

    new Setting(formEl)
      .setName("Target")
      .setDesc("Enter a number for the measure above, or type a unit such as 250w, 1800 chars, 3m, or 45s.")
      .addText((text) => {
        amountInput = text;
        text.setValue(formatWritingTargetInputValue(this.existingTarget));
        updateAmountInput();
        text.onChange((value) => {
          // Follow a unit as it is typed, so the measure always matches what will be saved.
          const typed = parseWritingTargetLine(`Target: ${value.trim()}`);
          if (typed && typed.metric !== metric) {
            metric = typed.metric;
            metricDropdown?.setValue(metric);
            updateAmountInput();
          }
        });
      });

    createWritingTargetPresetButtons(formEl, this.presets, (preset) => {
      metric = preset.metric;
      metricDropdown?.setValue(metric);
      amountInput?.setValue(formatWritingTargetInputValue(preset));
      updateAmountInput();
    });

    new Setting(formEl)
      .addButton((button) => {
        button
          .setButtonText(this.existingTarget ? "Update target" : "Add target")
          .setCta();
        button.buttonEl.type = "submit";
      });

    formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      if (amountInput === null) {
        return;
      }

      const target = parseWritingTargetInput(metric, amountInput.getValue());
      if (!target) {
        new Notice("Enter a target such as 250, 250w, 1800 chars, 3m, or 45s.");
        amountInput.inputEl.focus();
        return;
      }

      this.onSubmitTarget(target);
      this.close();
    });

    window.setTimeout(() => amountInput?.inputEl.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Quick-target buttons for the target dialog. */
export function createWritingTargetPresetButtons(
  parentEl: HTMLElement,
  presets: WritingTarget[],
  onPick: (preset: WritingTarget) => void
): void {
  if (presets.length === 0) {
    return;
  }

  const presetEl = parentEl.createDiv({ cls: "section-meter-target-presets" });
  presetEl.createDiv({ text: "Quick targets", cls: "setting-item-name" });
  const buttonsEl = presetEl.createDiv({ cls: "section-meter-target-preset-buttons" });
  for (const preset of presets) {
    // Obsidian's createEl ignores `type` on buttons. Without the attribute a
    // button submits its form, and pressing Enter would pick the first preset.
    const button = buttonsEl.createEl("button", {
      text: formatWritingTargetPreset(preset),
      cls: "section-meter-target-preset",
      attr: { type: "button" }
    });
    button.addEventListener("click", () => onPick(preset));
  }
}

/** A unit typed in the dialog wins; a bare number uses the selected measure. */
export function parseWritingTargetInput(
  metric: WritingTargetMetric,
  rawValue: string
): WritingTarget | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  const typed = parseWritingTargetLine(`Target: ${value}`);
  if (typed) {
    return typed;
  }

  if (!/^[\d,]+$/.test(value)) {
    return null;
  }

  if (metric === "reading-time") {
    return parseWritingTargetLine(`Target: ${value}m`);
  }

  const unit = metric === "words" ? "words" : "characters";
  return parseWritingTargetLine(`Target: ${value} ${unit}`);
}

function formatWritingTargetInputValue(target: WritingTarget | null): string {
  if (!target) {
    return "";
  }

  if (target.metric !== "reading-time") {
    return String(target.targetValue);
  }

  const minutes = Math.floor(target.targetValue / 60);
  const seconds = target.targetValue % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function getWritingTargetPresets(rawPresets: string): WritingTarget[] {
  return rawPresets
    .split(",")
    .map((preset) => parseWritingTargetLine(`Target: ${preset.trim()}`))
    .filter((preset): preset is WritingTarget => preset !== null);
}

function formatWritingTargetPreset(target: WritingTarget): string {
  if (target.metric === "reading-time") {
    return formatWritingTargetInputValue(target);
  }
  return `${target.targetValue} ${target.metric}`;
}

export function createSectionMeterExtension(
  getSettings: () => SectionMeterSettings,
  updateStatusBar: (status: StatusBarStats | null) => void,
  updateMobileMeterPosition: (
    position: SectionMeterSettings["mobileMeterPosition"]
  ) => void,
  openMobileTargetEditor: (view: EditorView, scope: WritingTargetScope, position: number) => void,
  cacheReadingTimes: (view: EditorView, summaries: ReadingTimeSummaries) => void,
  isActiveView: (view: EditorView) => boolean = () => true,
  onTargetsReached: (view: EditorView, reached: TargetCompletion[]) => void = () => {},
  getDocumentIdentity: (view: EditorView) => string | null = () => null
): Extension {
  if (!getSettings().enabled) {
    return [];
  }

  class SectionMeterViewPlugin implements PluginValue {
    decorations: DecorationSet;
    private summaries: SectionMeterSummary[];
    private noteSummary: ReturnType<typeof summarizeNoteReadingTime>;
    private analyzedDoc: Text;
    private completionTracker: TargetCompletionTracker;
    private documentIdentity: string | null;
    private selectionBadgeUpdateTimer: number | null = null;
    private selectionBadgeRefreshQueued = false;
    private selectionStatsCache: { doc: Text; key: string; stats: SelectionStats | null } | null = null;
    private selectionStatsComputedAt = Number.NEGATIVE_INFINITY;
    private selectionStatsTimer: number | null = null;
    private selectionStatsRefreshQueued = false;
    private documentStatsUpdateTimer: number | null = null;
    private documentStatsRefreshQueued = false;
    private documentStatsRefreshDeferred = false;
    private hasPendingStructuralHeadingChange = false;
    private applySelectionBadgeOverride = true;
    private mobileMeterEl: HTMLElement | null = null;
    private mobileMeterScrollDom: HTMLElement | null = null;
    private mobileMeterScrollHandler: (() => void) | null = null;
    private readonly mobileMeterMeasureKey = {};

    constructor(view: EditorView) {
      const markdown = view.state.doc.toString();
      const summaries = summarizeReadingTimes(markdown, getSettings());
      this.summaries = summaries.sections;
      this.noteSummary = summaries.note;
      this.analyzedDoc = view.state.doc;
      this.completionTracker = new TargetCompletionTracker(summaries);
      this.documentIdentity = getDocumentIdentity(view);
      cacheReadingTimes(view, summaries);
      this.decorations = this.buildDecorations(view);

      if (getSettings().mobileStickySectionMeter) {
        this.mobileMeterEl = createMobileSectionMeterEl(
          getSettings().mobileMeterPosition,
          updateMobileMeterPosition,
          (scope, position) => {
            if (view.state.doc !== this.analyzedDoc) {
              new Notice("Statistics are updating. Please try again in a moment.");
              return;
            }
            openMobileTargetEditor(view, scope, position);
          }
        );
        view.dom.appendChild(this.mobileMeterEl);
        this.mobileMeterScrollHandler = () => this.scheduleMobileMeterUpdate(view);
        this.mobileMeterScrollDom = view.scrollDOM;
        this.mobileMeterScrollDom.addEventListener("scroll", this.mobileMeterScrollHandler, { passive: true });
        this.scheduleMobileMeterUpdate(view);
      }
    }

    update(update: ViewUpdate) {
      const documentChangedIdentity = getDocumentIdentity(update.view) !== this.documentIdentity;
      if (documentChangedIdentity) {
        this.cancelDocumentStatsRefresh();
        this.refreshDocumentStats(update.view);
        this.documentStatsRefreshDeferred = false;
        this.hasPendingStructuralHeadingChange = false;
        this.decorations = this.buildDecorations(update.view);
      }
      if (update.docChanged && !documentChangedIdentity) {
        this.completionTracker.mapPositions((position) => update.changes.mapPos(position, 1, MapMode.TrackAfter));
        // A heading badge belongs to a parsed heading, not merely to a document
        // position. Mapping it through a structural heading edit can briefly
        // place an old badge in ordinary text when a heading is deleted or
        // recreated (especially on mobile). Ordinary prose edits can keep their
        // mapped badges while fresh statistics are prepared.
        const headingStructureChanged = documentChangesMayAffectHeadings(
          getDocumentChanges(update)
        );
        const editStartedInHeading = update.startState.selection.ranges.some((range) => (
          selectionIntersectsHeading(range.from, range.to, this.summaries)
        ));

        if (!headingStructureChanged && editStartedInHeading) {
          // Keep the badge at the actual end of the heading on every keystroke.
          // Updating the existing widget DOM avoids the blink caused by removing
          // and recreating it after a debounce.
          this.cancelDocumentStatsRefresh();
          this.refreshDocumentStats(update.view);
          this.documentStatsRefreshDeferred = false;
          this.hasPendingStructuralHeadingChange = false;
          this.decorations = this.buildDecorations(update.view);
        } else {
          this.decorations = headingStructureChanged
            ? Decoration.none
            : this.decorations.map(update.changes);
          this.hasPendingStructuralHeadingChange ||= headingStructureChanged;
          this.queueDocumentStatsRefresh(update.view);
        }
      }

      let shouldRebuildDecorations = update.viewportChanged
        && this.documentStatsUpdateTimer === null;
      if (this.documentStatsRefreshQueued) {
        this.documentStatsRefreshQueued = false;
        this.refreshDocumentStats(update.view);
        if (this.hasPendingStructuralHeadingChange
          || !this.selectionIsInsideHeading(update.view)) {
          shouldRebuildDecorations = true;
          this.documentStatsRefreshDeferred = false;
          this.hasPendingStructuralHeadingChange = false;
        } else {
          this.documentStatsRefreshDeferred = true;
        }
      }
      if (this.selectionBadgeRefreshQueued) {
        this.selectionBadgeRefreshQueued = false;
        this.applySelectionBadgeOverride = true;
        shouldRebuildDecorations = true;
      }
      if (this.selectionStatsRefreshQueued) {
        this.selectionStatsRefreshQueued = false;
        shouldRebuildDecorations = true;
      }

      if (update.selectionSet || update.focusChanged) {
        if (this.documentStatsRefreshDeferred && !this.selectionIsInsideHeading(update.view)) {
          this.documentStatsRefreshDeferred = false;
          this.hasPendingStructuralHeadingChange = false;
          shouldRebuildDecorations = true;
        }
        this.applySelectionBadgeOverride = false;
        if (update.view.state.selection.ranges.some((range) => !range.empty)) {
          this.queueSelectionBadgeRefresh(update.view);
        } else {
          this.cancelSelectionBadgeRefresh();
        }
        shouldRebuildDecorations ||= !update.docChanged
          && this.documentStatsUpdateTimer === null;
      }

      if (shouldRebuildDecorations) {
        this.decorations = this.buildDecorations(update.view);
      }

      if ((!update.docChanged && this.documentStatsUpdateTimer === null)
        || update.viewportChanged || documentChangedIdentity) {
        this.scheduleMobileMeterUpdate(update.view);
      }
    }

    destroy() {
      if (this.selectionBadgeUpdateTimer !== null) {
        window.clearTimeout(this.selectionBadgeUpdateTimer);
      }
      if (this.documentStatsUpdateTimer !== null) {
        window.clearTimeout(this.documentStatsUpdateTimer);
      }
      if (this.selectionStatsTimer !== null) {
        window.clearTimeout(this.selectionStatsTimer);
      }

      if (this.mobileMeterScrollDom && this.mobileMeterScrollHandler) {
        this.mobileMeterScrollDom.removeEventListener("scroll", this.mobileMeterScrollHandler);
      }
      this.mobileMeterEl?.remove();
      this.mobileMeterEl = null;
      this.mobileMeterScrollDom = null;
      this.mobileMeterScrollHandler = null;

      this.summaries = [];
    }

    private queueDocumentStatsRefresh(view: EditorView) {
      if (this.documentStatsUpdateTimer !== null) {
        window.clearTimeout(this.documentStatsUpdateTimer);
      }

      this.documentStatsUpdateTimer = window.setTimeout(() => {
        this.documentStatsUpdateTimer = null;
        this.documentStatsRefreshQueued = true;
        view.dispatch({});
      }, DOCUMENT_STATS_UPDATE_DELAY_MS);
    }

    private cancelDocumentStatsRefresh() {
      if (this.documentStatsUpdateTimer !== null) {
        window.clearTimeout(this.documentStatsUpdateTimer);
        this.documentStatsUpdateTimer = null;
      }
      this.documentStatsRefreshQueued = false;
    }

    private refreshDocumentStats(view: EditorView) {
      const summaries = summarizeReadingTimes(view.state.doc.toString(), getSettings());
      this.analyzedDoc = view.state.doc;
      const identity = getDocumentIdentity(view);
      if (identity !== this.documentIdentity) {
        this.completionTracker.reset(summaries);
        this.documentIdentity = identity;
      } else {
        const reached = this.completionTracker.update(summaries);
        if (reached.length > 0 && isActiveView(view)) onTargetsReached(view, reached);
      }
      this.summaries = summaries.sections;
      this.noteSummary = summaries.note;
      cacheReadingTimes(view, summaries);
    }

    private queueSelectionBadgeRefresh(view: EditorView) {
      if (this.selectionBadgeUpdateTimer !== null) {
        window.clearTimeout(this.selectionBadgeUpdateTimer);
      }

      this.selectionBadgeUpdateTimer = window.setTimeout(() => {
        this.selectionBadgeUpdateTimer = null;
        this.selectionBadgeRefreshQueued = true;
        view.dispatch({});
      }, SELECTION_BADGE_UPDATE_DELAY_MS);
    }

    private cancelSelectionBadgeRefresh() {
      if (this.selectionBadgeUpdateTimer !== null) {
        window.clearTimeout(this.selectionBadgeUpdateTimer);
        this.selectionBadgeUpdateTimer = null;
      }
      this.selectionBadgeRefreshQueued = false;
    }

    /**
     * Dragging a selection changes it on every pointer move. Reuse the count for
     * an unchanged selection, recount at most once per interval while it moves,
     * and catch up once the pointer settles so the final numbers are exact.
     */
    private getSelectionStats(view: EditorView): SelectionStats | null {
      const key = getSelectionKey(view);
      if (!key) {
        return null;
      }

      const cached = this.selectionStatsCache;
      if (cached?.doc === view.state.doc && cached.key === key) {
        return cached.stats;
      }

      if (cached && performance.now() - this.selectionStatsComputedAt < SELECTION_STATS_INTERVAL_MS) {
        this.queueSelectionStatsRefresh(view);
        return cached.stats;
      }

      const stats = summarizeSelection(view, getSettings());
      this.selectionStatsCache = { doc: view.state.doc, key, stats };
      this.selectionStatsComputedAt = performance.now();
      return stats;
    }

    private queueSelectionStatsRefresh(view: EditorView) {
      if (this.selectionStatsTimer !== null) {
        return;
      }

      this.selectionStatsTimer = window.setTimeout(() => {
        this.selectionStatsTimer = null;
        this.selectionStatsRefreshQueued = true;
        view.dispatch({});
      }, SELECTION_STATS_INTERVAL_MS);
    }

    private selectionIsInsideHeading(view: EditorView): boolean {
      return view.state.selection.ranges.some((range) => selectionIntersectsHeading(
        range.from,
        range.to,
        this.summaries
      ));
    }

    private buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const settings = getSettings();
      const statusBarStats = getStatusBarStats(
        view,
        settings,
        this.summaries,
        this.noteSummary,
        this.getSelectionStats(view)
      );
      const selectionOverride = this.applySelectionBadgeOverride && statusBarStats.selection
        ? getHeadingSelectionOverride(view, this.summaries, statusBarStats.selection)
        : null;
      if (isActiveView(view)) updateStatusBar(statusBarStats);

      if (!settings.showHeadingStats) {
        return builder.finish();
      }

      for (const summary of getVisibleSummaries(this.summaries, view.visibleRanges)) {
        const isSelectionTarget = selectionOverride?.headingFrom === summary.from;
        if (!isSelectionTarget && !summary.target && !shouldShowSummary(summary, settings)) {
          continue;
        }

        const label = isSelectionTarget ? selectionOverride.label : summary.label;
        const wordCount = isSelectionTarget ? selectionOverride.wordCount : summary.wordCount;
        const characterCount = isSelectionTarget
          ? selectionOverride.characterCount
          : summary.characterCount;
        const seconds = isSelectionTarget ? selectionOverride.seconds : summary.seconds;
        const target = isSelectionTarget ? null : summary.target;
        const scopeLabel = isSelectionTarget ? "Selection stats" : "Heading section stats";
        const badgeDoc = this.analyzedDoc;
        const badgeIdentity = this.documentIdentity;
        const withCurrentHeading = (action: () => void): void => {
          if (!view.dom.isConnected || view.state.doc !== badgeDoc
            || getDocumentIdentity(view) !== badgeIdentity) {
            new Notice("The note changed. Please tap the updated target again.");
            return;
          }
          action();
        };

        builder.add(
          summary.headingEnd,
          summary.headingEnd,
          Decoration.widget({
            widget: new ReadingTimeWidget(
              label,
              wordCount,
              characterCount,
              seconds,
              target,
              scopeLabel,
              badgeDoc,
              summary.from,
              () => ({
                edit: () => withCurrentHeading(() => openMobileTargetEditor(view, "section", summary.from)),
                remove: () => withCurrentHeading(() => {
                  const edit = createWritingTargetTextEdit(badgeDoc.toString(), "section", summary.from, null);
                  if (edit) view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.text } });
                })
              })
            ),
            side: 1
          })
        );
      }

      return builder.finish();
    }

    private scheduleMobileMeterUpdate(view: EditorView): void {
      if (!this.mobileMeterEl) {
        return;
      }
      this.mobileMeterEl.dataset.position = getSettings().mobileMeterPosition;
      if (!isActiveView(view)) {
        this.mobileMeterEl.classList.add("section-meter-mobile-current-section-hidden");
        return;
      }

      view.requestMeasure({
        key: this.mobileMeterMeasureKey,
        read: (measuredView) => getPositionAtVisibleViewportTop(measuredView),
        write: (position) => {
          if (isActiveView(view)) this.updateMobileMeterAtPosition(position);
          else this.mobileMeterEl?.classList.add("section-meter-mobile-current-section-hidden");
        }
      });
    }

    private updateMobileMeterAtPosition(position: number): void {
      if (!this.mobileMeterEl) {
        return;
      }

      const sectionSummary = getActiveSectionTargetSummaryAtPosition(
        this.summaries,
        position
      );
      const target = sectionSummary?.target ?? this.noteSummary.target;
      if (!target) {
        this.mobileMeterEl.classList.add("section-meter-mobile-current-section-hidden");
        return;
      }

      this.mobileMeterEl.classList.remove("section-meter-mobile-current-section-hidden");
      renderMobileSectionMeter(
        this.mobileMeterEl,
        target,
        sectionSummary ? "section" : "note",
        sectionSummary?.from ?? 0
      );
    }
  }

  return [
    ViewPlugin.fromClass(SectionMeterViewPlugin, {
      decorations: (plugin) => plugin.decorations
    }),
    getSettings().showTargetChips ? targetLineChipExtension : []
  ];
}

/**
 * Shows valid `Target:` lines as chips in Live Preview. Only the display
 * changes: the Markdown keeps the typed line, which reappears for editing
 * whenever the cursor or a selection touches it.
 */
class TargetLineChips implements PluginValue {
  decorations: DecorationSet;
  private targetLines: WritingTargetLine[];
  private reparseTimer: number | null = null;

  constructor(view: EditorView) {
    this.targetLines = parseWritingTargetLines(view.state.doc.toString());
    this.decorations = buildTargetLineChips(view, this.targetLines);
  }

  update(update: ViewUpdate) {
    const livePreviewChanged = isLivePreview(update.startState) !== isLivePreview(update.state);
    if (update.docChanged) {
      // Drop lines an edit touched until the debounced reparse validates them.
      this.targetLines = this.targetLines
        .filter((line) => !update.changes.touchesRange(line.from, line.to))
        .map((line) => ({
          ...line,
          from: update.changes.mapPos(line.from),
          to: update.changes.mapPos(line.to)
        }));
      this.queueReparse(update.view);
    }

    if (update.docChanged || update.selectionSet || update.viewportChanged || livePreviewChanged) {
      this.decorations = buildTargetLineChips(update.view, this.targetLines);
    }
  }

  destroy() {
    if (this.reparseTimer !== null) window.clearTimeout(this.reparseTimer);
    this.reparseTimer = null;
  }

  private queueReparse(view: EditorView) {
    if (this.reparseTimer !== null) window.clearTimeout(this.reparseTimer);
    this.reparseTimer = window.setTimeout(() => {
      this.reparseTimer = null;
      this.targetLines = parseWritingTargetLines(view.state.doc.toString());
      this.decorations = buildTargetLineChips(view, this.targetLines);
      view.dispatch({});
    }, DOCUMENT_STATS_UPDATE_DELAY_MS);
  }
}

const targetLineChipExtension = ViewPlugin.fromClass(TargetLineChips, {
  decorations: (plugin) => plugin.decorations
});

function isLivePreview(state: EditorState): boolean {
  return state.field(editorLivePreviewField, false) ?? false;
}

function buildTargetLineChips(view: EditorView, targetLines: WritingTargetLine[]): DecorationSet {
  if (!isLivePreview(view.state)) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder<Decoration>();
  const { ranges } = view.state.selection;
  for (const line of targetLines) {
    const isBeingEdited = ranges.some((range) => range.from <= line.to && range.to >= line.from);
    const isVisible = view.visibleRanges.some((range) => range.from <= line.to && range.to >= line.from);
    if (line.to > line.from && !isBeingEdited && isVisible) {
      builder.add(line.from, line.to, Decoration.replace({ widget: new TargetLineChipWidget(line) }));
    }
  }
  return builder.finish();
}

class TargetLineChipWidget extends WidgetType {
  private readonly value: string;

  constructor(target: WritingTarget) {
    super();
    const amount = formatWritingTargetLine(target).replace(/^Target: /, "");
    this.value = target.metric === "reading-time" ? `${amount} read` : amount;
  }

  eq(other: TargetLineChipWidget): boolean {
    return this.value === other.value;
  }

  toDOM(view: EditorView): HTMLElement {
    const chip = createSpan();
    chip.className = "section-meter-target-chip";
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-label", `Writing target: ${this.value}. Click to edit the target line.`);
    chip.setAttribute("title", "Click to edit");

    const iconEl = createSpan();
    iconEl.className = "section-meter-target-chip-icon";
    setIcon(iconEl, "target");
    const captionEl = createSpan();
    captionEl.className = "section-meter-target-chip-caption";
    captionEl.textContent = "Target";
    const valueEl = createSpan();
    valueEl.className = "section-meter-target-chip-value";
    valueEl.textContent = this.value;
    chip.append(iconEl, captionEl, valueEl);

    // Reveal the typed line by placing the cursor at its end.
    chip.addEventListener("mousedown", (event) => event.preventDefault());
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      const lineEnd = view.state.doc.lineAt(view.posAtDOM(chip)).to;
      view.dispatch({ selection: { anchor: lineEnd } });
      view.focus();
    });
    return chip;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function getDocumentChanges(update: ViewUpdate) {
  const changes: Array<{
    from: number;
    to: number;
    removedText: string;
    insertedText: string;
  }> = [];
  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({
      from: fromA,
      to: toA,
      removedText: update.startState.doc.sliceString(fromA, toA),
      insertedText: inserted.toString()
    });
  });
  return changes;
}

function getPositionAtVisibleViewportTop(view: EditorView): number {
  const viewportTop = view.scrollDOM.getBoundingClientRect().top;
  const documentHeight = Math.max(0, (viewportTop - view.documentTop) / view.scaleY);
  return view.lineBlockAtHeight(documentHeight).from;
}

function createMobileSectionMeterEl(
  position: SectionMeterSettings["mobileMeterPosition"],
  updatePosition: (position: SectionMeterSettings["mobileMeterPosition"]) => void,
  openTargetEditor: (scope: WritingTargetScope, position: number) => void
): HTMLElement {
  const meterEl = createDiv();
  meterEl.className = "section-meter-mobile-current-section section-meter-mobile-current-section-hidden";
  meterEl.dataset.displayMode = "percentage";
  meterEl.dataset.position = position;
  meterEl.setAttribute("role", "group");
  meterEl.setAttribute(
    "aria-label",
    "Current section statistics and writing target. Drag vertically to move the meter."
  );
  meterEl.setAttribute("aria-live", "off");
  // Keep these controls stable: focus changes can refresh the meter between
  // pointer-down and click. Replacing the pressed button would lose that tap.
  const targetEl = createSpan();
  targetEl.className = "section-meter-mobile-current-section-target";
  targetEl.dataset.mobileMeterAction = "edit-target";
  targetEl.setAttribute("role", "button");
  targetEl.tabIndex = 0;
  targetEl.setAttribute("aria-label", "Edit writing target.");

  const currentEl = createSpan();
  currentEl.className = "section-meter-mobile-current-section-current";
  const progressEl = createSpan();
  progressEl.className = "section-meter-mobile-current-section-progress";
  progressEl.setAttribute("aria-hidden", "true");
  const progressFillEl = createSpan();
  progressFillEl.className = "section-meter-mobile-current-section-progress-fill";
  progressEl.append(progressFillEl);
  targetEl.append(currentEl, progressEl);

  const labelEl = createSpan();
  labelEl.className = "section-meter-mobile-current-section-label";
  labelEl.dataset.mobileMeterAction = "toggle-target-display";
  labelEl.setAttribute("role", "button");
  labelEl.tabIndex = 0;
  const percentageEl = createSpan();
  percentageEl.className = "section-meter-mobile-current-section-percentage";
  const countEl = createSpan();
  countEl.className = "section-meter-mobile-current-section-count";
  labelEl.append(percentageEl, countEl);
  meterEl.append(targetEl, labelEl);
  addMobileMeterInteractionHandlers(meterEl, updatePosition, openTargetEditor);
  return meterEl;
}

function renderMobileSectionMeter(
  meterEl: HTMLElement,
  target: WritingTargetProgress,
  targetScope: WritingTargetScope,
  targetPosition: number
): void {
  const currentEl = meterEl.querySelector<HTMLElement>(".section-meter-mobile-current-section-current")!;
  currentEl.textContent = formatMobileTargetCurrentValue(target);

  const stateClass = getTargetProgressStateClass(target);
  const progressEl = meterEl.querySelector<HTMLElement>(".section-meter-mobile-current-section-progress")!;
  progressEl.className = ["section-meter-mobile-current-section-progress", stateClass].join(" ");
  // The label carries the reached state itself so the ✓ needs no :has() selector.
  meterEl.querySelector(".section-meter-mobile-current-section-label")
    ?.classList.toggle("section-meter-target-complete", stateClass === "section-meter-target-complete");
  const progressFillEl = meterEl.querySelector<HTMLElement>(".section-meter-mobile-current-section-progress-fill")!;
  progressFillEl.style.setProperty("--section-meter-progress", `${Math.min(100, Math.max(0, target.percent))}%`);

  const percentageEl = meterEl.querySelector<HTMLElement>(".section-meter-mobile-current-section-percentage")!;
  percentageEl.textContent = `${Math.round(target.percent)}%`;

  const countEl = meterEl.querySelector<HTMLElement>(".section-meter-mobile-current-section-count")!;
  countEl.textContent = formatWritingTargetCountLabel(target);

  meterEl.dataset.targetScope = targetScope;
  meterEl.dataset.targetPosition = String(targetPosition);
  meterEl.dataset.percentageLabel = percentageEl.textContent;
  meterEl.dataset.countLabel = countEl.textContent;
  updateMobileTargetAccessibilityLabel(meterEl);
}

function formatMobileTargetCurrentValue(target: WritingTargetProgress): string {
  if (target.metric === "reading-time") {
    return formatSeconds(target.currentValue);
  }

  return `${target.currentValue}${target.metric === "words" ? "w" : "c"}`;
}

function updateMobileTargetAccessibilityLabel(meterEl: HTMLElement): void {
  const targetEl = meterEl.querySelector<HTMLElement>(
    ".section-meter-mobile-current-section-label"
  );
  if (!targetEl) {
    return;
  }

  const showCount = meterEl.dataset.displayMode === "count";
  const visibleLabel = showCount
    ? meterEl.dataset.countLabel
    : meterEl.dataset.percentageLabel;
  const nextLabel = showCount ? "percentage" : "current value and target";
  targetEl.setAttribute(
    "aria-label",
    `Writing target ${visibleLabel ?? ""}. Tap to show ${nextLabel}.`
  );
  targetEl.setAttribute("aria-pressed", String(showCount));
}

function addMobileMeterInteractionHandlers(
  meterEl: HTMLElement,
  updatePosition: (position: SectionMeterSettings["mobileMeterPosition"]) => void,
  openTargetEditor: (scope: WritingTargetScope, position: number) => void
): void {
  const dragThreshold = 10;
  let activePointerId: number | null = null;
  let startY = 0;
  let startTop = 0;
  let meterHeight = 0;
  let dragged = false;
  let suppressNextClick = false;

  const stopTouchGesturePropagation = (event: TouchEvent): void => {
    event.stopPropagation();
  };
  meterEl.addEventListener("touchstart", stopTouchGesturePropagation, { passive: true });
  meterEl.addEventListener("touchmove", stopTouchGesturePropagation, { passive: true });
  meterEl.addEventListener("touchend", stopTouchGesturePropagation, { passive: true });
  meterEl.addEventListener("touchcancel", stopTouchGesturePropagation, { passive: true });

  meterEl.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (!event.isPrimary || event.button !== 0) {
      return;
    }

    const bounds = meterEl.getBoundingClientRect();
    activePointerId = event.pointerId;
    startY = event.clientY;
    startTop = bounds.top;
    meterHeight = bounds.height;
    dragged = false;
  });

  meterEl.addEventListener("pointermove", (event) => {
    event.stopPropagation();
    if (event.pointerId !== activePointerId) {
      return;
    }

    const deltaY = event.clientY - startY;
    if (!dragged && Math.abs(deltaY) < dragThreshold) {
      return;
    }

    dragged = true;
    event.preventDefault();
    if (!meterEl.hasPointerCapture(event.pointerId)) {
      meterEl.setPointerCapture(event.pointerId);
    }
    meterEl.classList.add("section-meter-mobile-current-section-dragging");
    const viewportHeight = meterEl.ownerDocument.defaultView?.innerHeight ?? window.innerHeight;
    const nextTop = Math.min(
      viewportHeight - meterHeight - 8,
      Math.max(8, startTop + deltaY)
    );
    meterEl.setCssProps({ "--section-meter-drag-top": `${nextTop}px` });
  });

  const finishDrag = (event: PointerEvent, cancelled: boolean): void => {
    if (event.pointerId !== activePointerId) {
      return;
    }

    if (meterEl.hasPointerCapture(event.pointerId)) {
      meterEl.releasePointerCapture(event.pointerId);
    }
    activePointerId = null;

    if (!dragged) {
      return;
    }

    suppressNextClick = !cancelled;
    if (!cancelled) {
      (meterEl.ownerDocument.defaultView ?? window).setTimeout(() => {
        suppressNextClick = false;
      }, 0);
    }
    const viewportHeight = meterEl.ownerDocument.defaultView?.innerHeight ?? window.innerHeight;
    const centerY = meterEl.getBoundingClientRect().top + (meterHeight / 2);
    const nextPosition = cancelled
      ? meterEl.dataset.position as SectionMeterSettings["mobileMeterPosition"]
      : centerY < viewportHeight / 2 ? "top" : "bottom";

    meterEl.classList.remove("section-meter-mobile-current-section-dragging");
    meterEl.setCssProps({ "--section-meter-drag-top": "" });
    meterEl.dataset.position = nextPosition;

    if (!cancelled) {
      updatePosition(nextPosition);
    }
  };

  meterEl.addEventListener("pointerup", (event) => {
    event.stopPropagation();
    finishDrag(event, false);
  });
  meterEl.addEventListener("pointercancel", (event) => {
    event.stopPropagation();
    finishDrag(event, true);
  });
  const runAction = (target: EventTarget | null): void => {
    const actionEl = (target as Element | null)?.closest<HTMLElement>(
      "[data-mobile-meter-action]"
    );
    if (actionEl?.dataset.mobileMeterAction === "toggle-target-display") {
      meterEl.dataset.displayMode = meterEl.dataset.displayMode === "count"
        ? "percentage"
        : "count";
      updateMobileTargetAccessibilityLabel(meterEl);
      return;
    }

    if (actionEl?.dataset.mobileMeterAction === "edit-target") {
      const scope = meterEl.dataset.targetScope === "note" ? "note" : "section";
      openTargetEditor(scope, Number(meterEl.dataset.targetPosition ?? 0));
    }
  };

  meterEl.addEventListener("click", (event) => {
    event.stopPropagation();
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    runAction(event.target);
  }, true);

  meterEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    runAction(event.target);
  });
}

class ReadingTimeWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly wordCount: number,
    private readonly characterCount: number,
    private readonly seconds: number,
    private readonly target: WritingTargetProgress | null,
    private readonly scopeLabel: string,
    private readonly doc: Text,
    private readonly position: number,
    private readonly getTargetActions: () => BadgeTargetActions | null
  ) {
    super();
  }

  eq(other: ReadingTimeWidget): boolean {
    return this.label === other.label
      && this.wordCount === other.wordCount
      && this.characterCount === other.characterCount
      && this.seconds === other.seconds
      && targetProgressesEqual(this.target, other.target)
      && this.scopeLabel === other.scopeLabel
      && this.doc === other.doc
      && this.position === other.position;
  }

  updateDOM(dom: HTMLElement): boolean {
    const replacement = this.toDOM();
    dom.className = replacement.className;
    // Only replace our attributes. CodeMirror owns other attributes on reused
    // widget DOM; removing them can make the badge part of the editable text.
    for (const attribute of Array.from(replacement.attributes)) {
      dom.setAttribute(attribute.name, attribute.value);
    }
    dom.replaceChildren(...Array.from(replacement.childNodes));
    return true;
  }

  toDOM(): HTMLElement {
    return createReadingTimeBadge(
      this.label,
      this.wordCount,
      this.characterCount,
      this.seconds,
      this.target,
      "",
      true,
      this.scopeLabel,
      this.getTargetActions
    );
  }

  get editable(): boolean {
    // A stats badge is UI, not part of the editor's text flow. Marking it
    // editable lets CodeMirror place text on either side of the widget while a
    // heading is being typed, which can split the heading around the badge.
    return false;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class SectionMeterSettingTab extends PluginSettingTab {
  private previewEl: HTMLElement | null = null;
  private badgePreviewValueEl: HTMLElement | null = null;
  private targetPreviewSlotEl: HTMLElement | null = null;
  private statusBarPreviewContentEl: HTMLElement | null = null;
  private previewResizeObserver: ResizeObserver | null = null;
  private previewScrollEl: HTMLElement | null = null;
  private previewHeight: number | null = null;

  constructor(app: App, private readonly plugin: SectionMeterPlugin) {
    super(app, plugin);
  }

  hide(): void {
    super.hide();
    this.previewResizeObserver?.disconnect();
    this.previewResizeObserver = null;
    this.previewScrollEl?.classList.remove("section-meter-settings-scroller");
    this.previewScrollEl = null;
    this.previewHeight = null;
  }

  /**
   * The pinned preview's labels may wrap as settings change. Scroll by the
   * same amount the preview grows or shrinks, so the row being changed stays
   * under the pointer. Browser scroll anchoring is disabled to avoid a double
   * adjustment.
   */
  private keepSettingsStillWhilePreviewResizes(previewEl: HTMLElement): void {
    this.previewResizeObserver?.disconnect();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    // The preview may not be attached yet, so find the scroller on first resize.
    this.previewResizeObserver = new ResizeObserver(() => {
      if (!previewEl.isConnected) return;
      if (!this.previewScrollEl?.isConnected || !this.previewScrollEl.contains(previewEl)) {
        this.previewScrollEl?.classList.remove("section-meter-settings-scroller");
        this.previewScrollEl = findScrollContainer(previewEl);
        this.previewScrollEl?.classList.add("section-meter-settings-scroller");
      }
      const scrollEl = this.previewScrollEl;
      if (!scrollEl) return;
      const bounds = previewEl.getBoundingClientRect();
      const change = this.previewHeight === null ? 0 : bounds.height - this.previewHeight;
      this.previewHeight = bounds.height;
      const previewIsAboveView = bounds.bottom <= scrollEl.getBoundingClientRect().top;
      if (change !== 0 && (this.plugin.settings.previewSticky || previewIsAboveView)) {
        scrollEl.scrollTop += change;
      }
    });
    this.previewResizeObserver.observe(previewEl);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.getPreviewSettings(),
      this.createBuildInfoSetting(),
      this.getBadgeSettings(),
      this.getStatusBarSettings(),
      this.getWritingTargetSettings(),
      this.getLabelFormatSettings(),
      this.getCountingSettings()
    ];
  }

  private getPreviewSettings(): SettingDefinitionGroup {
    return {
      type: "group",
      cls: "section-meter-settings-preview-group",
      items: [this.createDisplayPreviewSetting()]
    };
  }

  private getBadgeSettings(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Badges",
      items: [
        this.createToggleSetting(
          "Beside headings",
          "Show section stats beside Markdown headings in the editor and Reading view.",
          () => this.plugin.settings.showHeadingStats,
          async (value) => {
            this.plugin.settings.showHeadingStats = value;
            await this.plugin.saveSettings();
          },
          { aliases: ["Show heading stats"] }
        ),
        this.createToggleSetting(
          "Below the note title",
          "Show whole-note stats below the inline note title in the editor and Reading view.",
          () => this.plugin.settings.showInlineTitleStats,
          async (value) => {
            this.plugin.settings.showInlineTitleStats = value;
            await this.plugin.saveSettings();
          },
          { aliases: ["Show inline title stats"] }
        ),
        this.createMetricChipsSetting(
          "Show",
          "Choose what heading and title badges display.",
          [
            { label: "Words", getValue: () => this.plugin.settings.showWords,
              setValue: (value) => { this.plugin.settings.showWords = value; } },
            { label: "Reading time", getValue: () => this.plugin.settings.showTiming,
              setValue: (value) => { this.plugin.settings.showTiming = value; } },
            { label: "Characters", getValue: () => this.plugin.settings.showCharacters,
              setValue: (value) => { this.plugin.settings.showCharacters = value; } }
          ],
          ["Badge word count", "Badge reading time", "Badge character count"]
        ),
        this.createTextSetting(
          "Hide sections shorter than",
          "Number of words. Use 0 to show every heading, or 1 to hide empty sections. Sections with a target always show.",
          String(DEFAULT_SETTINGS.minimumWordCount),
          () => String(this.plugin.settings.minimumWordCount),
          async (value) => {
            this.plugin.settings.minimumWordCount = parseNonNegativeInteger(
              value,
              DEFAULT_SETTINGS.minimumWordCount
            );
            await this.plugin.saveSettings();
          },
          { aliases: ["Minimum word count", "Hide empty sections"] }
        )
      ]
    };
  }

  private getStatusBarSettings(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Status bar",
      items: [
        this.createToggleSetting(
          "Whole note",
          "Show whole-note stats in Obsidian's bottom status bar.",
          () => this.plugin.settings.showStatusBarNoteStats,
          async (value) => {
            this.plugin.settings.showStatusBarNoteStats = value;
            await this.plugin.saveSettings();
          },
          { updatePreviewAfterChange: true }
        ),
        this.createToggleSetting(
          "Selection",
          "Show selected-text stats in Obsidian's bottom status bar.",
          () => this.plugin.settings.showStatusBarSelectionStats,
          async (value) => {
            this.plugin.settings.showStatusBarSelectionStats = value;
            await this.plugin.saveSettings();
          },
          { updatePreviewAfterChange: true }
        ),
        this.createMetricChipsSetting(
          "Show",
          "Choose what the status bar displays.",
          [
            { label: "Words", getValue: () => this.plugin.settings.showStatusBarWords,
              setValue: (value) => { this.plugin.settings.showStatusBarWords = value; } },
            { label: "Reading time", getValue: () => this.plugin.settings.showStatusBarTiming,
              setValue: (value) => { this.plugin.settings.showStatusBarTiming = value; } },
            { label: "Characters", getValue: () => this.plugin.settings.showStatusBarCharacters,
              setValue: (value) => { this.plugin.settings.showStatusBarCharacters = value; } }
          ],
          ["Status bar word count", "Status bar reading time", "Status bar character count"]
        )
      ]
    };
  }

  private getWritingTargetSettings(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Writing targets",
      items: [
        this.createDropdownSetting(
          "Progress label",
          "Show target progress as a count, a percentage, or the amount left or over.",
          () => this.plugin.settings.targetProgressLabelStyle,
          {
            count: "Count (n/N)",
            percentage: "Percentage",
            remaining: "Remaining"
          },
          async (value) => {
            this.plugin.settings.targetProgressLabelStyle =
              normalizeTargetProgressLabelStyle(value);
            await this.plugin.saveSettings();
          },
          { updatePreviewAfterChange: true }
        ),
        this.createDropdownSetting(
          "Progress colours",
          "Theme accent turns green when reached and orange when over. Classic uses yellow, green, and red.",
          () => this.plugin.settings.classicTargetColors ? "classic" : "accent",
          {
            accent: "Theme accent",
            classic: "Classic"
          },
          async (value) => {
            this.plugin.settings.classicTargetColors = value === "classic";
            await this.plugin.saveSettings({ refreshStats: false });
          },
          { aliases: ["Classic progress colours", "Colors"] }
        ),
        this.createSliderSetting(
          "Warn when over",
          "Change the progress colour once writing reaches this percentage of the target.",
          MIN_TARGET_OVERAGE_WARNING_PERCENT,
          MAX_TARGET_OVERAGE_WARNING_PERCENT,
          TARGET_OVERAGE_WARNING_PERCENT_STEP,
          () => this.plugin.settings.targetOverageWarningPercent,
          async (value) => {
            this.plugin.settings.targetOverageWarningPercent = value;
            await this.plugin.saveSettings();
          },
          { aliases: ["Overage warning threshold"], updatePreviewAfterChange: true }
        ),
        this.createToggleSetting(
          "Show target lines as chips",
          "In Live Preview, show valid Target lines as chips. Click a chip to edit the line; the Markdown never changes.",
          () => this.plugin.settings.showTargetChips,
          async (value) => {
            this.plugin.settings.showTargetChips = value;
            await this.plugin.saveSettings();
          }
        ),
        this.createToggleSetting(
          "Notify when a target is reached",
          "Show a one-time notice when writing crosses a whole-note or section target.",
          () => this.plugin.settings.notifyOnTargetReached,
          async (value) => {
            this.plugin.settings.notifyOnTargetReached = value;
            await this.plugin.saveSettings({ refreshStats: false });
          }
        ),
        this.createTextSetting(
          "Quick target presets",
          "Comma-separated targets shown in the target dialog. Example: 250 words, 500 words, 10m.",
          DEFAULT_SETTINGS.targetPresets,
          () => this.plugin.settings.targetPresets,
          async (value) => {
            this.plugin.settings.targetPresets = value;
            await this.plugin.saveSettings({ refreshStats: false });
          }
        ),
        this.createToggleSetting(
          "Sticky target meter on mobile (Beta)",
          "Show the current target's progress while scrolling in the mobile editor. Tap the meter to switch between percentage and count.",
          () => this.plugin.settings.mobileStickySectionMeter,
          async (value) => {
            this.plugin.settings.mobileStickySectionMeter = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true, aliases: ["Sticky current-section meter", "Mobile"] }
        ),
        this.createDropdownSetting(
          "Meter position",
          "Place the meter above the mobile command toolbar or at the top of the editor.",
          () => this.plugin.settings.mobileMeterPosition,
          {
            bottom: "Bottom (above toolbar)",
            top: "Top of editor"
          },
          async (value) => {
            this.plugin.settings.mobileMeterPosition =
              normalizeMobileMeterPosition(value);
            await this.plugin.saveSettings({ refreshStats: false });
            this.plugin.refreshMobileMeterPlacement();
          },
          { visible: () => this.plugin.settings.mobileStickySectionMeter }
        ),
        this.createGuidanceSetting(
          "How to write targets",
          "Put a line under a heading, such as Target: 250 words, target 250w, Target: 1800 chars, or Target: 2m 30s. A target above the first heading applies to the whole note."
        )
      ]
    };
  }

  private getLabelFormatSettings(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Label format",
      items: [
        this.createToggleSetting(
          "Compact labels",
          "Use shorter labels like 640w, 3200 chars, and 3m 49s in badges and the status bar.",
          () => this.plugin.settings.compactMode,
          async (value) => {
            this.plugin.settings.compactMode = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true, aliases: ["Compact mode"] }
        ),
        this.createTextSetting(
          "Compact words label",
          "Suffix used for word counts in compact labels. Defaults to w.",
          DEFAULT_SETTINGS.compactWordsLabel,
          () => this.plugin.settings.compactWordsLabel,
          async (value) => {
            this.plugin.settings.compactWordsLabel =
              value.trim() || DEFAULT_SETTINGS.compactWordsLabel;
            await this.plugin.saveSettings();
          },
          {
            visible: () => this.plugin.settings.compactMode,
            updatePreviewAfterChange: true
          }
        ),
        this.createTextSetting(
          "Compact characters label",
          "Label used for character counts in compact labels. Defaults to char.",
          DEFAULT_SETTINGS.compactCharactersLabel,
          () => this.plugin.settings.compactCharactersLabel,
          async (value) => {
            this.plugin.settings.compactCharactersLabel =
              value.trim() || DEFAULT_SETTINGS.compactCharactersLabel;
            await this.plugin.saveSettings();
          },
          {
            visible: () => this.plugin.settings.compactMode,
            updatePreviewAfterChange: true
          }
        ),
        this.createTextSetting(
          "Compact minutes label",
          "Suffix used for minute estimates in compact labels. Defaults to m.",
          DEFAULT_SETTINGS.compactMinutesLabel,
          () => this.plugin.settings.compactMinutesLabel,
          async (value) => {
            this.plugin.settings.compactMinutesLabel =
              value.trim() || DEFAULT_SETTINGS.compactMinutesLabel;
            await this.plugin.saveSettings();
          },
          {
            visible: () => this.plugin.settings.compactMode,
            updatePreviewAfterChange: true
          }
        ),
        this.createToggleSetting(
          "Minutes only",
          "Hide seconds in reading-time labels once they reach a minute. Times below one minute still show seconds.",
          () => this.plugin.settings.showTimeAsMinutesOnly,
          async (value) => {
            this.plugin.settings.showTimeAsMinutesOnly = value;
            await this.plugin.saveSettings();
          },
          { updatePreviewAfterChange: true }
        ),
        this.createTextSetting(
          "Separator",
          "Single character placed between the parts of a label.",
          DEFAULT_SETTINGS.labelSeparator,
          () => this.plugin.settings.labelSeparator,
          async (value) => {
            this.plugin.settings.labelSeparator = normalizeSeparator(value);
            await this.plugin.saveSettings();
          },
          { updatePreviewAfterChange: true }
        )
      ]
    };
  }

  private getCountingSettings(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Counting",
      items: [
        this.createReadingSpeedSetting(),
        this.createToggleSetting(
          "Count spaces in characters",
          "Count normalized spaces between words in character counts.",
          () => this.plugin.settings.countCharactersWithSpaces,
          async (value) => {
            this.plugin.settings.countCharactersWithSpaces = value;
            await this.plugin.saveSettings();
          },
          {
            aliases: ["Count spaces"],
            disabled: () => !this.plugin.settings.showCharacters
              && !this.plugin.settings.showStatusBarCharacters
          }
        )
      ]
    };
  }

  /** Obsidian has no multi-select control, so each option is a pressed/unpressed button. */
  private createMetricChipsSetting(
    name: string,
    desc: string,
    chips: { label: string; getValue: () => boolean; setValue: (value: boolean) => void }[],
    aliases: string[]
  ): SettingDefinition {
    return {
      name,
      desc,
      aliases,
      render: (setting) => {
        setting.setName(name).setDesc(desc);
        setting.controlEl.classList.add("section-meter-setting-chips");
        for (const chip of chips) {
          setting.addButton((button) => {
            const isOn = chip.getValue();
            button.setButtonText(chip.label).onClick(async () => {
              chip.setValue(!chip.getValue());
              // Normalizing turns another option back on if this was the last one.
              await this.plugin.saveSettings();
              this.update();
            });
            button.buttonEl.classList.add("section-meter-setting-chip");
            button.buttonEl.classList.toggle("mod-cta", isOn);
            button.buttonEl.setAttribute("aria-pressed", String(isOn));
          });
        }
      }
    };
  }

  private createReadingSpeedSetting(): SettingDefinition {
    return {
      name: "Reading speed",
      desc: "Words per minute used to estimate reading time.",
      aliases: ["Words per minute", "WPM"],
      render: (setting) => {
        setting.setName("Reading speed")
          .setDesc("Words per minute used to estimate reading time.");
        const guidanceEl = setting.descEl.createDiv({
          cls: "section-meter-setting-guidance",
          text: getReadingSpeedGuidance(this.plugin.settings.wordsPerMinute)
        });

        setting.addSlider((slider) => slider
          .setLimits(MIN_WORDS_PER_MINUTE, MAX_WORDS_PER_MINUTE, WORDS_PER_MINUTE_STEP)
          .setValue(this.plugin.settings.wordsPerMinute)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.wordsPerMinute = value;
            guidanceEl.textContent = getReadingSpeedGuidance(value);
            await this.plugin.saveSettings();
            this.updateDisplayPreview();
          }));
      }
    };
  }

  private createDisplayPreviewSetting(): SettingDefinition {
    return {
      name: "Live preview",
      desc: "Preview heading badges and status-bar statistics while changing settings.",
      aliases: ["Keep live preview visible", "Pin preview"],
      render: (setting) => {
        setting.settingEl.empty();
        setting.settingEl.classList.add("section-meter-settings-preview-row");
        const previewGroupEl = setting.settingEl.closest<HTMLElement>(
          ".section-meter-settings-preview-group"
        );
        this.previewEl = previewGroupEl ?? setting.settingEl;
        this.previewEl.classList.toggle(
          "section-meter-settings-preview-static",
          !this.plugin.settings.previewSticky
        );
        this.keepSettingsStillWhilePreviewResizes(this.previewEl);
        const settings = this.plugin.settings;
        const previewEl = setting.settingEl.createDiv({
          cls: "section-meter-settings-preview"
        });

        const headerEl = previewEl.createDiv({
          cls: "section-meter-settings-preview-heading"
        });
        headerEl.createSpan({ text: "Live preview" });
        const pinButton = headerEl.createEl("button", {
          cls: "clickable-icon section-meter-settings-preview-pin",
          attr: { type: "button" }
        });
        const updatePinButton = () => {
          const pinned = this.plugin.settings.previewSticky;
          setIcon(pinButton, pinned ? "pin" : "pin-off");
          pinButton.setAttribute("aria-label", pinned
            ? "Preview stays visible while scrolling. Click to unpin."
            : "Pin the preview so it stays visible while scrolling.");
          pinButton.setAttribute("aria-pressed", String(pinned));
          pinButton.classList.toggle("is-active", pinned);
        };
        updatePinButton();
        pinButton.addEventListener("click", () => {
          this.plugin.settings.previewSticky = !this.plugin.settings.previewSticky;
          updatePinButton();
          this.updatePreviewSticky();
          void this.plugin.saveSettings({ refreshStats: false });
        });

        const examplesEl = previewEl.createDiv({
          cls: "section-meter-settings-preview-examples"
        });

        const badgePreview = createSettingsHeadingPreview(settings);
        this.badgePreviewValueEl = badgePreview.valueEl;
        examplesEl.appendChild(badgePreview.el);

        this.targetPreviewSlotEl = examplesEl.createDiv({
          cls: "section-meter-settings-preview-slot"
        });
        this.targetPreviewSlotEl.appendChild(createSettingsTargetPreview(settings));

        const statusBarPreview = createSettingsStatusBarPreview(settings);
        this.statusBarPreviewContentEl = statusBarPreview.contentEl;
        examplesEl.appendChild(statusBarPreview.el);
      }
    };
  }

  private createBuildInfoSetting(): SettingDefinition {
    return {
      name: "Build information",
      searchable: false,
      render: (setting) => {
        setting.settingEl.empty();
        setting.settingEl.classList.add("section-meter-settings-preview-build-row");
        setting.settingEl.createDiv({
          cls: "section-meter-settings-preview-build",
          text: createBuildInfoLabel(this.plugin.manifest.version)
        });
      }
    };
  }

  private updatePreviewSticky(): void {
    this.previewEl?.classList.toggle(
      "section-meter-settings-preview-static",
      !this.plugin.settings.previewSticky
    );
  }

  private updateDisplayPreview(): void {
    const settings = this.plugin.settings;
    if (this.badgePreviewValueEl) {
      this.badgePreviewValueEl.textContent = formatReadingTime(
        PREVIEW_WORD_COUNT,
        PREVIEW_CHARACTER_COUNT,
        {
          wordsPerMinute: settings.wordsPerMinute,
          showWords: settings.showWords,
          showTiming: settings.showTiming,
          showCharacters: settings.showCharacters,
          compactMode: settings.compactMode,
          compactWordsLabel: settings.compactWordsLabel,
          compactCharactersLabel: settings.compactCharactersLabel,
          compactMinutesLabel: settings.compactMinutesLabel,
          showTimeAsMinutesOnly: settings.showTimeAsMinutesOnly,
          labelSeparator: settings.labelSeparator
        }
      );
    }

    this.targetPreviewSlotEl?.replaceChildren(createSettingsTargetPreview(settings));

    if (this.statusBarPreviewContentEl) {
      this.statusBarPreviewContentEl.replaceChildren(
        ...createSettingsStatusBarParts(settings)
      );
    }
  }

  private createToggleSetting(
    name: string,
    desc: string,
    getValue: () => boolean,
    onChange: (value: boolean) => void | Promise<void>,
    options: SettingRowOptions = {}
  ): SettingDefinition {
    return {
      name,
      desc,
      aliases: options.aliases,
      visible: options.visible,
      render: (setting) => {
        setting.setName(name)
          .setDesc(desc)
          .addToggle((toggle) => toggle
            .setValue(getValue())
            .setDisabled(options.disabled?.() ?? false)
            .onChange(async (value) => {
              await onChange(value);
              this.refreshAfterSettingChange(options);
            }));
      }
    };
  }

  private createTextSetting(
    name: string,
    desc: string,
    placeholder: string,
    getValue: () => string,
    onChange: (value: string) => void | Promise<void>,
    options: SettingRowOptions = {}
  ): SettingDefinition {
    return {
      name,
      desc,
      aliases: options.aliases,
      visible: options.visible,
      render: (setting) => {
        setting.setName(name)
          .setDesc(desc)
          .addText((text) => text
            .setPlaceholder(placeholder)
            .setValue(getValue())
            .onChange(async (value) => {
              await onChange(value);
              this.refreshAfterSettingChange(options);
            }));
      }
    };
  }

  private createSliderSetting(
    name: string,
    desc: string,
    min: number,
    max: number,
    step: number,
    getValue: () => number,
    onChange: (value: number) => void | Promise<void>,
    options: SettingRowOptions = {}
  ): SettingDefinition {
    return {
      name,
      desc,
      aliases: options.aliases,
      visible: options.visible,
      render: (setting) => {
        setting.setName(name)
          .setDesc(desc)
          .addSlider((slider) => slider
            .setLimits(min, max, step)
            .setValue(getValue())
            .setDynamicTooltip()
            .onChange(async (value) => {
              await onChange(value);
              this.refreshAfterSettingChange(options);
            }));
      }
    };
  }

  private createDropdownSetting(
    name: string,
    desc: string,
    getValue: () => string,
    options: Record<string, string>,
    onChange: (value: string) => void | Promise<void>,
    rowOptions: SettingRowOptions = {}
  ): SettingDefinition {
    return {
      name,
      desc,
      aliases: rowOptions.aliases,
      visible: rowOptions.visible,
      render: (setting) => {
        setting.setName(name)
          .setDesc(desc)
          .addDropdown((dropdown) => dropdown
            .addOptions(options)
            .setValue(getValue())
            .onChange(async (value) => {
              await onChange(value);
              this.refreshAfterSettingChange(rowOptions);
            }));
      }
    };
  }

  private createGuidanceSetting(name: string, desc: string): SettingDefinition {
    return { name, desc };
  }

  private refreshAfterSettingChange(options: SettingRowOptions): void {
    if (options.updateAfterChange) {
      this.update();
      return;
    }
    if (options.updatePreviewAfterChange) {
      this.updateDisplayPreview();
    }
  }
}

type SettingRowOptions = {
  aliases?: string[];
  disabled?: () => boolean;
  visible?: () => boolean;
  updateAfterChange?: boolean;
  updatePreviewAfterChange?: boolean;
};

function createBuildInfoLabel(version: string): string {
  const buildLabel = typeof __SECTION_METER_BUILD_LABEL__ === "string"
    ? __SECTION_METER_BUILD_LABEL__.trim()
    : "";

  return buildLabel.length > 0
    ? `Section Writing Stats ${version} · ${buildLabel}`
    : `Section Writing Stats ${version}`;
}

function createSettingsHeadingPreview(
  settings: SectionMeterSettings
): { el: HTMLElement; valueEl: HTMLElement } {
  const el = createDiv();
  el.className = "section-meter-settings-preview-example";

  const labelEl = createDiv();
  labelEl.className = "section-meter-settings-preview-example-label";
  labelEl.textContent = "Heading badge";
  el.appendChild(labelEl);

  const headingEl = createDiv();
  headingEl.className = "section-meter-settings-preview-heading-sample";
  const markerEl = createSpan();
  markerEl.className = "section-meter-settings-preview-heading-marker";
  markerEl.textContent = "#";
  headingEl.appendChild(markerEl);

  const textEl = createSpan();
  textEl.textContent = "Example heading";
  headingEl.appendChild(textEl);

  const badgeEl = createReadingTimeBadge(
    createPreviewHeadingLabel(settings),
    PREVIEW_WORD_COUNT,
    PREVIEW_CHARACTER_COUNT,
    estimateSeconds(PREVIEW_WORD_COUNT, settings.wordsPerMinute),
    null,
    "section-meter-settings-preview-badge",
    false,
    "Heading badge preview"
  );
  const valueEl = badgeEl.querySelector<HTMLElement>(".section-meter-badge-label");
  if (!valueEl) {
    throw new Error("Heading badge preview label was not created");
  }
  headingEl.appendChild(badgeEl);
  el.appendChild(headingEl);

  return { el, valueEl };
}

function findScrollContainer(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  return null;
}

function createSettingsTargetPreview(settings: SectionMeterSettings): HTMLElement {
  const el = createDiv();
  el.className = "section-meter-settings-preview-example";

  const labelEl = createDiv();
  labelEl.className = "section-meter-settings-preview-example-label";
  labelEl.textContent = "Section with a target";
  el.appendChild(labelEl);

  const headingEl = createDiv();
  headingEl.className = "section-meter-settings-preview-heading-sample";
  const markerEl = createSpan();
  markerEl.className = "section-meter-settings-preview-heading-marker";
  markerEl.textContent = "##";
  const textEl = createSpan();
  textEl.textContent = "Opening scene";
  headingEl.append(markerEl, textEl);

  const words = Array.from({ length: PREVIEW_TARGET_WORD_COUNT }, () => "word").join(" ");
  const [summary] = summarizeSectionReadingTimes(
    `# Preview\nTarget: ${PREVIEW_TARGET_WORDS} words\n${words}`,
    settings
  );
  if (summary) {
    headingEl.appendChild(createReadingTimeBadge(
      summary.label,
      summary.wordCount,
      summary.characterCount,
      summary.seconds,
      summary.target,
      "section-meter-settings-preview-badge",
      false,
      "Target badge preview"
    ));
  }
  el.appendChild(headingEl);
  return el;
}

function createPreviewHeadingLabel(settings: SectionMeterSettings): string {
  return formatReadingTime(PREVIEW_WORD_COUNT, PREVIEW_CHARACTER_COUNT, {
    wordsPerMinute: settings.wordsPerMinute,
    showWords: settings.showWords,
    showTiming: settings.showTiming,
    showCharacters: settings.showCharacters,
    compactMode: settings.compactMode,
    compactWordsLabel: settings.compactWordsLabel,
    compactCharactersLabel: settings.compactCharactersLabel,
    compactMinutesLabel: settings.compactMinutesLabel,
    showTimeAsMinutesOnly: settings.showTimeAsMinutesOnly,
    labelSeparator: settings.labelSeparator
  });
}

function createSettingsStatusBarPreview(
  settings: SectionMeterSettings
): { el: HTMLElement; contentEl: HTMLElement } {
  const el = createDiv();
  el.className = "section-meter-settings-preview-example";

  const labelEl = createDiv();
  labelEl.className = "section-meter-settings-preview-example-label";
  labelEl.textContent = "Status bar";
  el.appendChild(labelEl);

  const barEl = createDiv();
  barEl.className = "section-meter-settings-preview-statusbar";
  const contentEl = createSpan();
  contentEl.className = "section-meter-settings-preview-statusbar-content";
  barEl.appendChild(contentEl);
  el.appendChild(barEl);
  contentEl.replaceChildren(...createSettingsStatusBarParts(settings));

  return { el, contentEl };
}

function createSettingsStatusBarParts(settings: SectionMeterSettings): HTMLElement[] {
  const previewStats: SelectionStats = {
    wordCount: PREVIEW_WORD_COUNT,
    characterCount: PREVIEW_CHARACTER_COUNT,
    seconds: estimateSeconds(PREVIEW_WORD_COUNT, settings.wordsPerMinute),
    label: "",
    target: null
  };
  const parts: HTMLElement[] = [];

  if (settings.showStatusBarNoteStats) {
    parts.push(createStatusBarStatsEl("Note", previewStats, settings));
  }

  if (settings.showStatusBarSelectionStats) {
    const selectionPart = createSpan();
    selectionPart.className = "section-meter-settings-preview-statusbar-segment";
    if (parts.length > 0) {
      selectionPart.appendChild(createStatusBarSeparatorEl());
    }
    selectionPart.appendChild(createStatusBarStatsEl("Selection", previewStats, settings));
    parts.push(selectionPart);
  }

  if (parts.length === 0) {
    const emptyEl = createSpan();
    emptyEl.className = "section-meter-settings-preview-statusbar-empty";
    emptyEl.textContent = "Only active section targets appear";
    parts.push(emptyEl);
  }

  return parts;
}

type SelectionStats = Pick<
  SectionMeterSummary,
  "wordCount" | "characterCount" | "seconds" | "label" | "target"
>;

type SelectionOverride = SelectionStats & {
  headingFrom: number;
};

type StatusBarStats = {
  note: SelectionStats;
  selection: SelectionStats | null;
  sectionTarget: WritingTargetProgress | null;
};

function getVisibleSummaries(
  summaries: SectionMeterSummary[],
  ranges: readonly { from: number; to: number }[]
): SectionMeterSummary[] {
  const visibleSummaries: SectionMeterSummary[] = [];

  for (const range of ranges) {
    let low = 0;
    let high = summaries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (summaries[middle].headingEnd < range.from) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    for (let index = low;
      index < summaries.length && summaries[index].headingEnd <= range.to;
      index++) {
      visibleSummaries.push(summaries[index]);
    }
  }

  return visibleSummaries;
}

function createStatusBarRenderKey(
  status: StatusBarStats | null,
  settings: SectionMeterSettings
): string {
  return JSON.stringify([
    settings.showStatusBarNoteStats,
    settings.showStatusBarSelectionStats,
    settings.showStatusBarWords,
    settings.showStatusBarTiming,
    settings.showStatusBarCharacters,
    settings.wordsPerMinute,
    settings.compactMode,
    settings.compactWordsLabel,
    settings.compactCharactersLabel,
    settings.compactMinutesLabel,
    settings.showTimeAsMinutesOnly,
    settings.labelSeparator,
    status
  ]);
}

function getStatusBarStats(
  view: EditorView,
  settings: SectionMeterSettings,
  summaries: SectionMeterSummary[],
  note: ReturnType<typeof summarizeNoteReadingTime>,
  selection: SelectionStats | null = summarizeSelection(view, settings)
): StatusBarStats {
  return {
    note,
    selection,
    sectionTarget: getSectionTargetAtSelection(view, summaries)
  };
}

function getSelectionKey(view: EditorView): string {
  return view.state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => `${range.from}:${range.to}`)
    .join(",");
}

function summarizeSelection(view: EditorView, settings: SectionMeterSettings): SelectionStats | null {
  const selectedText = view.state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => view.state.sliceDoc(range.from, range.to))
    .join("\n")
    .trim();
  if (!selectedText) {
    return null;
  }

  const selection = summarizeNoteReadingTime(selectedText, settings);
  return selection.wordCount === 0 && selection.characterCount === 0
    ? null
    : { ...selection, target: null };
}

function getSectionTargetAtSelection(
  view: EditorView,
  summaries: SectionMeterSummary[]
): WritingTargetProgress | null {
  const position = Math.min(...view.state.selection.ranges.map((range) => range.from));
  return getActiveSectionTargetAtPosition(summaries, position);
}

function getHeadingSelectionOverride(
  view: EditorView,
  summaries: SectionMeterSummary[],
  selectionStats: SelectionStats
): SelectionOverride | null {
  const selectedRanges = view.state.selection.ranges.filter((range) => !range.empty);
  if (selectedRanges.length === 0) {
    return null;
  }

  const selectionFrom = Math.min(...selectedRanges.map((range) => range.from));
  const selectionTo = Math.max(...selectedRanges.map((range) => range.to));
  const targetHeading = getSelectionTargetHeading(summaries, selectionFrom, selectionTo);
  if (!targetHeading) {
    return null;
  }

  return {
    headingFrom: targetHeading.from,
    wordCount: selectionStats.wordCount,
    characterCount: selectionStats.characterCount,
    seconds: selectionStats.seconds,
    label: selectionStats.label,
    target: null
  };
}

function getSelectionTargetHeading(
  summaries: SectionMeterSummary[],
  selectionFrom: number,
  selectionTo: number
): SectionMeterSummary | null {
  const includedHeading = summaries.find((summary) =>
    rangesOverlap(summary.from, summary.headingEnd, selectionFrom, selectionTo)
  );
  const targetPosition = includedHeading?.from ?? selectionFrom;

  for (let index = summaries.length - 1; index >= 0; index--) {
    if (summaries[index].from < targetPosition) {
      return summaries[index];
    }
  }

  return null;
}

function rangesOverlap(
  firstFrom: number,
  firstTo: number,
  secondFrom: number,
  secondTo: number
): boolean {
  return firstFrom < secondTo && secondFrom < firstTo;
}

function normalizeSettings(settings: StoredSettings): SectionMeterSettings {
  const displaySettings = normalizeDisplaySettings(settings);
  const statusBarDisplaySettings = normalizeStatusBarDisplaySettings(settings);

  return {
    enabled: normalizeBoolean(settings.enabled, DEFAULT_SETTINGS.enabled),
    wordsPerMinute: normalizeWordsPerMinute(settings.wordsPerMinute),
    ...displaySettings,
    compactMode: normalizeBoolean(settings.compactMode, DEFAULT_SETTINGS.compactMode),
    compactWordsLabel: normalizeCompactLabel(
      settings.compactWordsLabel,
      DEFAULT_SETTINGS.compactWordsLabel
    ),
    compactCharactersLabel: normalizeCompactLabel(
      settings.compactCharactersLabel,
      DEFAULT_SETTINGS.compactCharactersLabel
    ),
    compactMinutesLabel: normalizeCompactLabel(
      settings.compactMinutesLabel,
      DEFAULT_SETTINGS.compactMinutesLabel
    ),
    showTimeAsMinutesOnly: normalizeBoolean(
      settings.showTimeAsMinutesOnly,
      DEFAULT_SETTINGS.showTimeAsMinutesOnly
    ),
    countCharactersWithSpaces:
      normalizeBoolean(
        settings.countCharactersWithSpaces,
        DEFAULT_SETTINGS.countCharactersWithSpaces
      ),
    labelSeparator: normalizeSeparator(settings.labelSeparator),
    // "Hide empty sections" is now a minimum of one word.
    minimumWordCount: settings.hideEmptySections === true
      ? Math.max(1, parseNonNegativeInteger(settings.minimumWordCount, DEFAULT_SETTINGS.minimumWordCount))
      : parseNonNegativeInteger(settings.minimumWordCount, DEFAULT_SETTINGS.minimumWordCount),
    hideEmptySections: false,
    showHeadingStats: normalizeBoolean(
      settings.showHeadingStats,
      DEFAULT_SETTINGS.showHeadingStats
    ),
    showInlineTitleStats: normalizeBoolean(
      settings.showInlineTitleStats,
      DEFAULT_SETTINGS.showInlineTitleStats
    ),
    showStatusBarNoteStats:
      normalizeBoolean(
        settings.showStatusBarNoteStats,
        DEFAULT_SETTINGS.showStatusBarNoteStats
      ),
    showStatusBarSelectionStats:
      normalizeBoolean(
        settings.showStatusBarSelectionStats,
        DEFAULT_SETTINGS.showStatusBarSelectionStats
      ),
    ...statusBarDisplaySettings,
    targetOverageWarningPercent: normalizeTargetOverageWarningPercent(
      settings.targetOverageWarningPercent
    ),
    targetProgressLabelStyle: normalizeTargetProgressLabelStyle(
      settings.targetProgressLabelStyle
    ),
    targetPresets: normalizeTargetPresets(settings.targetPresets),
    notifyOnTargetReached: normalizeBoolean(
      settings.notifyOnTargetReached,
      DEFAULT_SETTINGS.notifyOnTargetReached
    ),
    classicTargetColors: normalizeBoolean(
      settings.classicTargetColors,
      DEFAULT_SETTINGS.classicTargetColors
    ),
    showTargetChips: normalizeBoolean(settings.showTargetChips, DEFAULT_SETTINGS.showTargetChips),
    mobileStickySectionMeter: normalizeBoolean(
      settings.mobileStickySectionMeter,
      DEFAULT_SETTINGS.mobileStickySectionMeter
    ),
    mobileMeterPosition: normalizeMobileMeterPosition(settings.mobileMeterPosition),
    previewSticky: normalizeBoolean(settings.previewSticky, DEFAULT_SETTINGS.previewSticky)
  };
}

function readStoredSettings(value: unknown): StoredSettings {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatStatusBarStats(
  stats: SelectionStats,
  settings: SectionMeterSettings
): string {
  const labels = [formatConfiguredStats(stats, settings)];

  if (stats.target) {
    labels.push(formatTargetProgressForStatus(stats.target));
  }

  return labels.join(" - ");
}

function formatTargetProgressForStatus(target: WritingTargetProgress): string {
  return `Target: ${target.label}`;
}

function formatConfiguredStats(
  stats: Pick<SelectionStats, "wordCount" | "characterCount" | "seconds">,
  settings: SectionMeterSettings
): string {
  return formatReadingTime(stats.wordCount, stats.characterCount, {
    wordsPerMinute: settings.wordsPerMinute,
    showWords: settings.showStatusBarWords,
    showTiming: settings.showStatusBarTiming,
    showCharacters: settings.showStatusBarCharacters,
    compactMode: settings.compactMode,
    compactWordsLabel: settings.compactWordsLabel,
    compactCharactersLabel: settings.compactCharactersLabel,
    compactMinutesLabel: settings.compactMinutesLabel,
    showTimeAsMinutesOnly: settings.showTimeAsMinutesOnly,
    labelSeparator: settings.labelSeparator
  });
}

// Saving replaces the settings object (normalizeSettings), so a key cached per
// object can never go stale; this avoids re-serializing on every cache check.
const readingTimeSettingsKeys = new WeakMap<SectionMeterSettings, string>();

function getReadingTimeSettingsKey(settings: SectionMeterSettings): string {
  let key = readingTimeSettingsKeys.get(settings);
  if (key === undefined) {
    // These preferences change controls/placement, not parsed statistics or labels.
    key = JSON.stringify({ ...settings, previewSticky: null, mobileMeterPosition: null,
      targetPresets: null, notifyOnTargetReached: null, classicTargetColors: null, showTargetChips: null });
    readingTimeSettingsKeys.set(settings, key);
  }
  return key;
}

function removeTitleBadge(container: HTMLElement): void {
  container.querySelectorAll(".section-meter-title-badge").forEach((badge) => badge.remove());
  container.querySelectorAll<HTMLElement>(".section-meter-title-row")
    .forEach((row) => row.removeClass("section-meter-title-row"));
  container.querySelectorAll<HTMLElement>(".section-meter-title-group").forEach((group) => {
    const title = group.querySelector<HTMLElement>(":scope > .inline-title");
    if (title && group.parentElement) group.parentElement.insertBefore(title, group);
    group.remove();
  });
}

interface BadgeTargetActions {
  edit: () => unknown;
  remove: () => unknown;
}

function createReadingTimeBadge(
  label: string,
  wordCount: number,
  characterCount: number,
  seconds: number,
  target: WritingTargetProgress | null,
  extraClass = "",
  interactiveStats = false,
  scopeLabel = "Reading stats",
  getTargetActions?: () => BadgeTargetActions | null
): HTMLElement {
  const badge = createSpan();
  badge.className = ["section-meter-badge", extraClass].filter(Boolean).join(" ");
  const labelEl = createSpan();
  labelEl.className = "section-meter-badge-label";
  labelEl.textContent = label;
  badge.appendChild(labelEl);

  if (target) {
    badge.classList.add("section-meter-target-badge");
    badge.classList.add(getTargetProgressStateClass(target));
    const targetGroup = createBadgeTargetGroupEl(target);
    if (getTargetActions) {
      addBadgeMenuHandlers(targetGroup, "Target actions", () => {
        const actions = getTargetActions();
        return actions ? new Menu()
          .addItem((item) => item.setTitle("Edit target").setIcon("pencil").onClick(actions.edit))
          .addItem((item) => item.setTitle("Remove target").setIcon("trash").setWarning(true).onClick(actions.remove)) : null;
      });
    }
    badge.appendChild(targetGroup);
  }

  badge.setAttribute(
    "aria-label",
    target
      ? `${scopeLabel}: ${label}, target ${target.label}, ${Math.round(target.percent)}% of target`
      : `${scopeLabel}: ${wordCount} ${wordCount === 1 ? "word" : "words"}, ${characterCount} ${characterCount === 1 ? "character" : "characters"}, ${formatDurationForLabel(seconds)} read`
  );
  badge.setAttribute("title", scopeLabel);
  badge.setAttribute("spellcheck", "false");
  badge.setAttribute("contenteditable", "false");
  badge.addEventListener("beforeinput", (event) => event.preventDefault());
  badge.addEventListener("keydown", preventBadgeTextEdit);
  badge.addEventListener("mousedown", stopEditorMouseHandling);
  badge.addEventListener("pointerdown", stopEditorMouseHandling);

  if (interactiveStats) {
    addBadgeMenuHandlers(labelEl, "Statistics actions", () => new Menu()
      .addItem((item) => item.setTitle("Copy statistics").setIcon("copy").onClick(async () => {
        try {
          await labelEl.ownerDocument.defaultView?.navigator.clipboard.writeText(label);
          new Notice("Statistics copied.");
        } catch {
          new Notice("Statistics could not be copied.");
        }
      })));
  }

  return badge;
}

function createBadgeTargetGroupEl(target: WritingTargetProgress): HTMLElement {
  const groupEl = createSpan();
  groupEl.className = "section-meter-target-group";

  const captionEl = createSpan();
  captionEl.className = "section-meter-target-caption";
  setIcon(captionEl, "target");
  groupEl.appendChild(captionEl);
  groupEl.appendChild(createTargetLabelEl(target));
  groupEl.appendChild(createTargetProgressEl(target));

  return groupEl;
}

function createStatusBarStatsEl(
  scopeLabel: string,
  stats: SelectionStats,
  settings: SectionMeterSettings
): HTMLElement {
  const wrapper = createSpan();
  wrapper.className = "section-meter-status-bar-part";

  const labelEl = createSpan();
  labelEl.textContent = `${scopeLabel}: ${formatConfiguredStats(stats, settings)}`;
  wrapper.appendChild(labelEl);

  if (stats.target) {
    wrapper.classList.add("section-meter-status-bar-target");
    wrapper.appendChild(createInlineTargetSeparatorEl());
    const targetTextEl = createTargetLabelEl(stats.target);
    targetTextEl.classList.add("section-meter-status-bar-target-label");
    targetTextEl.textContent = formatTargetProgressForStatus(stats.target);
    wrapper.appendChild(targetTextEl);
    wrapper.appendChild(createTargetProgressEl(stats.target));
  }

  return wrapper;
}

function createStatusBarTargetEl(target: WritingTargetProgress): HTMLElement {
  const wrapper = createSpan();
  wrapper.className = "section-meter-status-bar-part section-meter-status-bar-target";

  const targetTextEl = createTargetLabelEl(target);
  targetTextEl.classList.add("section-meter-status-bar-target-label");
  targetTextEl.textContent = formatTargetProgressForStatus(target);
  wrapper.appendChild(targetTextEl);
  wrapper.appendChild(createTargetProgressEl(target));

  return wrapper;
}

function createStatusBarSeparatorEl(): HTMLElement {
  const separator = createSpan();
  separator.className = "section-meter-status-bar-separator";
  separator.textContent = "|";
  return separator;
}

function createTargetLabelEl(target: WritingTargetProgress): HTMLElement {
  const labelEl = createSpan();
  labelEl.className = ["section-meter-target-label", getTargetProgressStateClass(target)].join(" ");
  labelEl.textContent = target.label;
  return labelEl;
}

function createInlineTargetSeparatorEl(): HTMLElement {
  const separator = createSpan();
  separator.className = "section-meter-target-separator";
  separator.textContent = "|";
  return separator;
}

function createTargetProgressEl(target: WritingTargetProgress): HTMLElement {
  const progressEl = createSpan();
  progressEl.className = [
    "section-meter-target-progress",
    getTargetProgressStateClass(target)
  ].join(" ");
  progressEl.setAttribute("aria-hidden", "true");

  const fillEl = createSpan();
  fillEl.className = "section-meter-target-progress-fill";
  fillEl.style.setProperty("--section-meter-progress", `${Math.min(100, Math.max(0, target.percent))}%`);
  progressEl.appendChild(fillEl);
  return progressEl;
}

function getTargetProgressStateClass(target: WritingTargetProgress): string {
  if (target.isOverageWarning) {
    return "section-meter-target-overage";
  }

  if (target.isComplete) {
    return "section-meter-target-complete";
  }

  if (target.percent >= 80) {
    return "section-meter-target-close";
  }

  if (target.percent >= 50) {
    return "section-meter-target-mid";
  }

  return "section-meter-target-start";
}

function stopEditorMouseHandling(event: Event) {
  event.stopPropagation();
}

function addBadgeMenuHandlers(element: HTMLElement, label: string, createMenu: () => Menu | null): void {
  element.classList.add("section-meter-badge-action");
  element.setAttribute("role", "button");
  element.setAttribute("tabindex", "0");
  element.setAttribute("aria-label", label);
  element.setAttribute("aria-haspopup", "menu");
  element.setAttribute("title", label);
  const show = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = element.getBoundingClientRect();
    createMenu()?.showAtPosition({ x: bounds.left, y: bounds.bottom }, element.ownerDocument);
  };
  element.addEventListener("click", show);
  element.addEventListener("contextmenu", show);
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " " || event.key === "ContextMenu"
      || (event.shiftKey && event.key === "F10")) show(event);
  });
}

function preventBadgeTextEdit(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }

  const editingKeys = new Set([
    "Backspace",
    "Delete",
    "Enter"
  ]);

  if (event.key.length === 1 || editingKeys.has(event.key)) {
    event.preventDefault();
  }
}

function formatDurationForLabel(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function targetProgressesEqual(
  first: WritingTargetProgress | null,
  second: WritingTargetProgress | null
): boolean {
  if (!first || !second) {
    return first === second;
  }

  return first.metric === second.metric
    && first.currentValue === second.currentValue
    && first.targetValue === second.targetValue
    && first.percent === second.percent
    && first.isComplete === second.isComplete
    && first.isOverageWarning === second.isOverageWarning
    && first.label === second.label;
}

function normalizeDisplaySettings(
  settings: StoredSettings
): Pick<SectionMeterSettings, "showWords" | "showTiming" | "showCharacters"> {
  const legacy = normalizeLegacyLabelStyle(settings.labelStyle);
  const migrated = legacy
    ? displaySettingsFromLegacyLabelStyle(legacy)
    : {
      showWords: normalizeBoolean(settings.showWords, DEFAULT_SETTINGS.showWords),
      showTiming: normalizeBoolean(settings.showTiming, DEFAULT_SETTINGS.showTiming),
      showCharacters: normalizeBoolean(settings.showCharacters, DEFAULT_SETTINGS.showCharacters)
    };

  if (!migrated.showWords && !migrated.showTiming && !migrated.showCharacters) {
    return {
      ...migrated,
      showTiming: true
    };
  }

  return migrated;
}

function normalizeStatusBarDisplaySettings(
  settings: StoredSettings
): Pick<
  SectionMeterSettings,
  "showStatusBarWords" | "showStatusBarTiming" | "showStatusBarCharacters"
> {
  const normalized = {
    showStatusBarWords:
      normalizeBoolean(settings.showStatusBarWords, DEFAULT_SETTINGS.showStatusBarWords),
    showStatusBarTiming:
      normalizeBoolean(settings.showStatusBarTiming, DEFAULT_SETTINGS.showStatusBarTiming),
    showStatusBarCharacters:
      normalizeBoolean(
        settings.showStatusBarCharacters,
        DEFAULT_SETTINGS.showStatusBarCharacters
      )
  };

  if (!normalized.showStatusBarWords
    && !normalized.showStatusBarTiming
    && !normalized.showStatusBarCharacters) {
    return {
      ...normalized,
      showStatusBarWords: true
    };
  }

  return normalized;
}

function normalizeSeparator(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.labelSeparator;
  }

  return Array.from(value.trim())[0] ?? DEFAULT_SETTINGS.labelSeparator;
}

function normalizeCompactLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim() || fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeLegacyLabelStyle(value: unknown): LegacyLabelStyle | null {
  const labelStyles: LegacyLabelStyle[] = [
    "words",
    "time",
    "characters",
    "words-and-time",
    "words-and-minutes",
    "words-and-characters",
    "characters-and-time",
    "words-characters-and-time"
  ];

  return labelStyles.includes(value as LegacyLabelStyle) ? value as LegacyLabelStyle : null;
}

function getReadingSpeedGuidance(wordsPerMinute: number): string {
  if (wordsPerMinute <= 150) {
    return `${wordsPerMinute} WPM: close to a typical read-aloud pace.`;
  }

  if (wordsPerMinute <= 190) {
    return `${wordsPerMinute} WPM: a slower, careful silent-reading pace.`;
  }

  if (wordsPerMinute <= 260) {
    return `${wordsPerMinute} WPM: around a typical adult silent-reading pace.`;
  }

  if (wordsPerMinute <= 350) {
    return `${wordsPerMinute} WPM: a fast silent-reading pace.`;
  }

  return `${wordsPerMinute} WPM: very fast skimming or speed-reading territory.`;
}

function displaySettingsFromLegacyLabelStyle(labelStyle: LegacyLabelStyle) {
  return {
    showWords: labelStyle === "words"
      || labelStyle === "words-and-time"
      || labelStyle === "words-and-minutes"
      || labelStyle === "words-and-characters"
      || labelStyle === "words-characters-and-time",
    showTiming: labelStyle === "time"
      || labelStyle === "words-and-time"
      || labelStyle === "words-and-minutes"
      || labelStyle === "characters-and-time"
      || labelStyle === "words-characters-and-time",
    showCharacters: labelStyle === "characters"
      || labelStyle === "words-and-characters"
      || labelStyle === "characters-and-time"
      || labelStyle === "words-characters-and-time"
  };
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeWordsPerMinute(value: unknown): number {
  const parsed = parsePositiveInteger(value, DEFAULT_SETTINGS.wordsPerMinute);
  const stepped = Math.round(parsed / WORDS_PER_MINUTE_STEP) * WORDS_PER_MINUTE_STEP;
  return Math.min(MAX_WORDS_PER_MINUTE, Math.max(MIN_WORDS_PER_MINUTE, stepped));
}

function normalizeTargetOverageWarningPercent(value: unknown): number {
  const parsed = parsePositiveInteger(value, DEFAULT_SETTINGS.targetOverageWarningPercent);
  const stepped = Math.round(parsed / TARGET_OVERAGE_WARNING_PERCENT_STEP)
    * TARGET_OVERAGE_WARNING_PERCENT_STEP;

  return Math.min(
    MAX_TARGET_OVERAGE_WARNING_PERCENT,
    Math.max(MIN_TARGET_OVERAGE_WARNING_PERCENT, stepped)
  );
}

function normalizeTargetProgressLabelStyle(value: unknown): SectionMeterSettings["targetProgressLabelStyle"] {
  return value === "percentage" || value === "remaining"
    ? value
    : DEFAULT_SETTINGS.targetProgressLabelStyle;
}

function normalizeTargetPresets(value: unknown): string {
  return typeof value === "string" ? value : DEFAULT_SETTINGS.targetPresets;
}

function normalizeMobileMeterPosition(
  value: unknown
): SectionMeterSettings["mobileMeterPosition"] {
  return value === "top" ? "top" : DEFAULT_SETTINGS.mobileMeterPosition;
}

function parseNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function getEditorView(markdownView: MarkdownView): EditorView | null {
  const editor = markdownView.editor as unknown as { cm?: EditorView };
  return editor.cm ?? null;
}
