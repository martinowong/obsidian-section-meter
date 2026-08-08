import { Compartment, Extension, RangeSetBuilder, Text } from "@codemirror/state";
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
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TextComponent
} from "obsidian";
import type {
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionItem
} from "obsidian";
import {
  SectionMeterSettings,
  SectionMeterSummary,
  ReadingTimeSummaries,
  LegacyLabelStyle,
  WritingTarget,
  WritingTargetMetric,
  WritingTargetProgress,
  WritingTargetScope,
  createWritingTargetTextEdit,
  formatReadingTime,
  formatWritingTargetCountLabel,
  getActiveSectionTargetAtPosition,
  getActiveSectionTargetSummaryAtPosition,
  estimateSeconds,
  parseWritingTargetLine,
  shouldShowSummary,
  summarizeNoteReadingTime,
  summarizeReadingTimes,
  summarizeSectionReadingTimes
} from "./src/readingTime";

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
  mobileStickySectionMeter: false,
  mobileMeterPosition: "bottom",
  previewSticky: true
};
const MIN_WORDS_PER_MINUTE = 100;
const MAX_WORDS_PER_MINUTE = 500;
const WORDS_PER_MINUTE_STEP = 10;
const MIN_TARGET_OVERAGE_WARNING_PERCENT = 100;
const MAX_TARGET_OVERAGE_WARNING_PERCENT = 200;
const TARGET_OVERAGE_WARNING_PERCENT_STEP = 5;
const DOCUMENT_STATS_UPDATE_DELAY_MS = 120;
const SELECTION_BADGE_UPDATE_DELAY_MS = 220;
const TITLE_BADGE_UPDATE_DELAY_MS = DOCUMENT_STATS_UPDATE_DELAY_MS + 40;
const PREVIEW_WORD_COUNT = 640;
const PREVIEW_CHARACTER_COUNT = 3200;

type StoredSettings = Partial<Record<keyof SectionMeterSettings, unknown>> & {
  labelStyle?: unknown;
};

export default class SectionMeterPlugin extends Plugin {
  settings: SectionMeterSettings = DEFAULT_SETTINGS;
  private extensionCompartment = new Compartment();
  private statusBarItem: HTMLElement | null = null;
  private lastStatusBarRenderKey = "hidden";
  private titleBadgeUpdateTimer: number | null = null;
  private readingTimeCache = new WeakMap<EditorView, {
    doc: Text;
    settings: SectionMeterSettings;
    summaries: ReadingTimeSummaries;
  }>();

  async onload() {
    await this.loadSettings();
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.classList.add("section-meter-status-bar");
    this.clearStatusBar();

    this.registerEditorExtension(
      this.extensionCompartment.of(createSectionMeterExtension(
        () => this.settings,
        (status) => this.updateStatusBar(status),
        (position) => this.updateMobileMeterPosition(position),
        (view, summaries) => this.cacheReadingTimes(view, summaries)
      ))
    );
    this.addSettingTab(new SectionMeterSettingTab(this.app, this));
    this.registerWritingTargetCommands();
    this.registerStatsDisplayCommands();
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.refreshTitleBadges();
        this.refreshStatusBarFromActiveView();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.refreshTitleBadges();
        this.refreshStatusBarFromActiveView();
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
      this.refreshTitleBadges();
      this.refreshStatusBarFromActiveView();
    });
  }

  onunload() {
    if (this.titleBadgeUpdateTimer !== null) {
      window.clearTimeout(this.titleBadgeUpdateTimer);
      this.titleBadgeUpdateTimer = null;
    }
  }

  async loadSettings() {
    const loadedSettings: unknown = await this.loadData();
    this.settings = normalizeSettings(readStoredSettings(loadedSettings));
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
    this.refreshEditorExtensions();
    this.refreshTitleBadges();
    this.refreshStatusBarFromActiveView();
  }

  private updateMobileMeterPosition(position: SectionMeterSettings["mobileMeterPosition"]): void {
    if (this.settings.mobileMeterPosition === position) {
      return;
    }

    this.settings.mobileMeterPosition = position;
    void this.saveSettings();
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

  private openWritingTargetModal(editor: Editor, scope: WritingTargetScope) {
    const context = getWritingTargetCommandContext(editor, scope, this.settings);
    if (!context) {
      new Notice("Place the cursor inside a heading section first.");
      return;
    }

    new WritingTargetModal(
      this.app,
      scope,
      context.existingTarget,
      (target) => {
        const currentContext = getWritingTargetCommandContext(editor, scope, this.settings);
        if (!currentContext) {
          new Notice("The current section could not be found.");
          return;
        }

        const edit = createWritingTargetTextEdit(
          currentContext.markdown,
          scope,
          currentContext.position,
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
      (view, summaries) => this.cacheReadingTimes(view, summaries)
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

  private refreshTitleBadges() {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (leaf.view instanceof MarkdownView) {
        this.refreshTitleBadge(leaf.view);
      }
    });
  }

  private refreshStatusBarFromActiveView() {
    if (!this.settings.enabled) {
      this.clearStatusBar();
      return;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      this.clearStatusBar();
      return;
    }

    const editorView = getEditorView(activeView);
    if (editorView) {
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
      settings: this.settings,
      summaries
    });
  }

  private getCachedReadingTimes(view: EditorView): ReadingTimeSummaries | null {
    const cached = this.readingTimeCache.get(view);
    return cached?.doc === view.state.doc && cached.settings === this.settings
      ? cached.summaries
      : null;
  }

  private scheduleTitleBadgeRefresh(markdownView: MarkdownView) {
    if (this.titleBadgeUpdateTimer !== null) {
      window.clearTimeout(this.titleBadgeUpdateTimer);
    }

    this.titleBadgeUpdateTimer = window.setTimeout(() => {
      this.titleBadgeUpdateTimer = null;
      this.refreshTitleBadge(markdownView);
    }, TITLE_BADGE_UPDATE_DELAY_MS);
  }

  private refreshTitleBadge(markdownView: MarkdownView) {
    const container = markdownView.containerEl;
    container
      .querySelectorAll(".section-meter-title-badge")
      .forEach((badge) => badge.remove());
    container
      .querySelectorAll<HTMLElement>(".section-meter-title-group")
      .forEach((group) => {
        const titleEl = group.querySelector<HTMLElement>(":scope > .inline-title");
        if (titleEl && group.parentElement) {
          group.parentElement.insertBefore(titleEl, group);
        }
        group.remove();
      });

    if (!this.settings.enabled || !this.settings.showInlineTitleStats) {
      return;
    }

    const titleEl = container.querySelector<HTMLElement>(".inline-title");
    const titleRow = titleEl?.parentElement;
    if (!titleEl || !titleRow) {
      return;
    }

    const editorView = getEditorView(markdownView);
    const summary = (editorView ? this.getCachedReadingTimes(editorView)?.note : null)
      ?? summarizeNoteReadingTime(markdownView.getViewData(), this.settings);
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
    const titleGroup = titleRow.createDiv({ cls: "section-meter-title-group" });
    titleRow.insertBefore(titleGroup, titleEl);
    titleGroup.append(titleEl, badge);
  }

  private updateStatusBar(status: StatusBarStats | null) {
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
  settings: SectionMeterSettings
): WritingTargetCommandContext | null {
  const markdown = editor.getValue();
  const position = editor.posToOffset(editor.getCursor());
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

    const updateAmountInput = () => {
      if (amountInput === null) {
        return;
      }

      amountInput.setPlaceholder(metric === "reading-time" ? "3m or 2m 30s" : "250");
      amountInput.inputEl.inputMode = metric === "reading-time" ? "text" : "numeric";
    };

    new Setting(formEl)
      .setName("Measure")
      .addDropdown((dropdown) => dropdown
        .addOption("words", "Words")
        .addOption("characters", "Characters")
        .addOption("reading-time", "Reading time")
        .setValue(metric)
        .onChange((value) => {
          metric = value as WritingTargetMetric;
          updateAmountInput();
        }));

    new Setting(formEl)
      .setName("Target")
      .setDesc("Enter a positive number, or a time such as 3m or 2m 30s.")
      .addText((text) => {
        amountInput = text;
        text.setValue(formatWritingTargetInputValue(this.existingTarget));
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
        new Notice("Enter a valid positive writing target.");
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

function parseWritingTargetInput(
  metric: WritingTargetMetric,
  rawValue: string
): WritingTarget | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  if (metric === "reading-time") {
    const normalizedValue = /^\d+$/.test(value) ? `${value}m` : value;
    return parseWritingTargetLine(`Target: ${normalizedValue}`);
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
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function createSectionMeterExtension(
  getSettings: () => SectionMeterSettings,
  updateStatusBar: (status: StatusBarStats | null) => void,
  updateMobileMeterPosition: (
    position: SectionMeterSettings["mobileMeterPosition"]
  ) => void,
  cacheReadingTimes: (view: EditorView, summaries: ReadingTimeSummaries) => void
): Extension {
  if (!getSettings().enabled) {
    return [];
  }

  class SectionMeterViewPlugin implements PluginValue {
    decorations: DecorationSet;
    private summaries: SectionMeterSummary[];
    private noteSummary: ReturnType<typeof summarizeNoteReadingTime>;
    private selectionBadgeUpdateTimer: number | null = null;
    private selectionBadgeRefreshQueued = false;
    private documentStatsUpdateTimer: number | null = null;
    private documentStatsRefreshQueued = false;
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
      cacheReadingTimes(view, summaries);
      this.decorations = this.buildDecorations(view);

      if (getSettings().mobileStickySectionMeter) {
        this.mobileMeterEl = createMobileSectionMeterEl(
          getSettings().mobileMeterPosition,
          updateMobileMeterPosition
        );
        view.dom.appendChild(this.mobileMeterEl);
        this.mobileMeterScrollHandler = () => this.scheduleMobileMeterUpdate(view);
        this.mobileMeterScrollDom = view.scrollDOM;
        this.mobileMeterScrollDom.addEventListener("scroll", this.mobileMeterScrollHandler, { passive: true });
        this.scheduleMobileMeterUpdate(view);
      }
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes);
        this.queueDocumentStatsRefresh(update.view);
      }

      let shouldRebuildDecorations = update.viewportChanged
        && this.documentStatsUpdateTimer === null;
      if (this.documentStatsRefreshQueued) {
        this.documentStatsRefreshQueued = false;
        const markdown = update.state.doc.toString();
        const summaries = summarizeReadingTimes(markdown, getSettings());
        this.summaries = summaries.sections;
        this.noteSummary = summaries.note;
        cacheReadingTimes(update.view, summaries);
        shouldRebuildDecorations = true;
      }
      if (this.selectionBadgeRefreshQueued) {
        this.selectionBadgeRefreshQueued = false;
        this.applySelectionBadgeOverride = true;
        shouldRebuildDecorations = true;
      }

      if (update.selectionSet || update.focusChanged) {
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
        || update.viewportChanged) {
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

    private buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const settings = getSettings();
      const statusBarStats = getStatusBarStats(
        view,
        settings,
        this.summaries,
        this.noteSummary
      );
      const selectionOverride = this.applySelectionBadgeOverride && statusBarStats.selection
        ? getHeadingSelectionOverride(view, this.summaries, statusBarStats.selection)
        : null;
      updateStatusBar(statusBarStats);

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
              scopeLabel
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

      view.requestMeasure({
        key: this.mobileMeterMeasureKey,
        read: (measuredView) => getPositionAtVisibleViewportTop(measuredView),
        write: (position) => this.updateMobileMeterAtPosition(position)
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
      const summary = sectionSummary ?? this.noteSummary;
      const target = sectionSummary?.target ?? this.noteSummary.target;
      if (!target) {
        this.mobileMeterEl.classList.add("section-meter-mobile-current-section-hidden");
        return;
      }

      this.mobileMeterEl.classList.remove("section-meter-mobile-current-section-hidden");
      renderMobileSectionMeter(this.mobileMeterEl, target, summary, getSettings());
    }
  }

  return ViewPlugin.fromClass(SectionMeterViewPlugin, {
    decorations: (plugin) => plugin.decorations
  });
}

function getPositionAtVisibleViewportTop(view: EditorView): number {
  const viewportTop = view.scrollDOM.getBoundingClientRect().top;
  const documentHeight = Math.max(0, (viewportTop - view.documentTop) / view.scaleY);
  return view.lineBlockAtHeight(documentHeight).from;
}

function createMobileSectionMeterEl(
  position: SectionMeterSettings["mobileMeterPosition"],
  updatePosition: (position: SectionMeterSettings["mobileMeterPosition"]) => void
): HTMLElement {
  activeDocument
    .querySelectorAll(".section-meter-mobile-current-section")
    .forEach((meter) => meter.remove());

  const meterEl = createDiv();
  meterEl.className = "section-meter-mobile-current-section";
  meterEl.dataset.displayMode = "percentage";
  meterEl.dataset.position = position;
  meterEl.setAttribute("role", "group");
  meterEl.setAttribute(
    "aria-label",
    "Current section statistics and writing target. Drag vertically to move the meter."
  );
  meterEl.setAttribute("aria-live", "off");
  addMobileMeterInteractionHandlers(meterEl, updatePosition);
  return meterEl;
}

function renderMobileSectionMeter(
  meterEl: HTMLElement,
  target: WritingTargetProgress,
  stats: Pick<SectionMeterSummary, "wordCount" | "characterCount" | "seconds">,
  settings: SectionMeterSettings
): void {
  const supplementalMetrics = getMobileSupplementalMetrics(target.metric);
  const currentSupplementalMetric = supplementalMetrics.includes(
    meterEl.dataset.supplementalMetric as WritingTargetMetric
  )
    ? meterEl.dataset.supplementalMetric as WritingTargetMetric
    : supplementalMetrics[0];

  meterEl.dataset.supplementalMetric = currentSupplementalMetric;
  meterEl.dataset.supplementalPrimaryMetric = supplementalMetrics[0];
  meterEl.dataset.supplementalSecondaryMetric = supplementalMetrics[1];
  meterEl.dataset.supplementalPrimaryLabel = formatMobileSupplementalMetric(
    supplementalMetrics[0],
    stats,
    settings
  );
  meterEl.dataset.supplementalSecondaryLabel = formatMobileSupplementalMetric(
    supplementalMetrics[1],
    stats,
    settings
  );

  const supplementalEl = createEl("button");
  supplementalEl.type = "button";
  supplementalEl.className = "section-meter-mobile-current-section-stat";
  supplementalEl.dataset.mobileMeterAction = "supplemental";

  const targetEl = createEl("button");
  targetEl.type = "button";
  targetEl.className = "section-meter-mobile-current-section-target";
  targetEl.dataset.mobileMeterAction = "target";

  const progressEl = createTargetProgressEl(target);
  progressEl.classList.add("section-meter-mobile-current-section-progress");

  const labelEl = createSpan();
  labelEl.className = "section-meter-mobile-current-section-label";

  const percentageEl = createSpan();
  percentageEl.className = "section-meter-mobile-current-section-percentage";
  percentageEl.textContent = `${Math.round(target.percent)}%`;

  const countEl = createSpan();
  countEl.className = "section-meter-mobile-current-section-count";
  countEl.textContent = formatWritingTargetCountLabel(target);

  labelEl.append(percentageEl, countEl);
  targetEl.append(progressEl, labelEl);
  meterEl.replaceChildren(supplementalEl, targetEl);
  meterEl.dataset.percentageLabel = percentageEl.textContent;
  meterEl.dataset.countLabel = countEl.textContent;
  updateMobileSupplementalMetric(meterEl);
  updateMobileTargetAccessibilityLabel(meterEl);
}

function getMobileSupplementalMetrics(
  targetMetric: WritingTargetMetric
): [WritingTargetMetric, WritingTargetMetric] {
  if (targetMetric === "words") {
    return ["characters", "reading-time"];
  }

  if (targetMetric === "characters") {
    return ["words", "reading-time"];
  }

  return ["words", "characters"];
}

function formatMobileSupplementalMetric(
  metric: WritingTargetMetric,
  stats: Pick<SectionMeterSummary, "wordCount" | "characterCount" | "seconds">,
  settings: SectionMeterSettings
): string {
  return formatReadingTime(stats.wordCount, stats.characterCount, {
    ...settings,
    showWords: metric === "words",
    showCharacters: metric === "characters",
    showTiming: metric === "reading-time",
    compactMode: true,
    showTimeAsMinutesOnly: false
  });
}

function updateMobileSupplementalMetric(meterEl: HTMLElement): void {
  const supplementalEl = meterEl.querySelector<HTMLElement>(
    ".section-meter-mobile-current-section-stat"
  );
  if (!supplementalEl) {
    return;
  }

  const showPrimary = meterEl.dataset.supplementalMetric
    === meterEl.dataset.supplementalPrimaryMetric;
  const visibleLabel = showPrimary
    ? meterEl.dataset.supplementalPrimaryLabel
    : meterEl.dataset.supplementalSecondaryLabel;
  const nextLabel = showPrimary
    ? meterEl.dataset.supplementalSecondaryLabel
    : meterEl.dataset.supplementalPrimaryLabel;
  supplementalEl.textContent = visibleLabel ?? "";
  supplementalEl.setAttribute(
    "aria-label",
    `${visibleLabel ?? "Section statistic"}. Tap to show ${nextLabel ?? "the other statistic"}.`
  );
}

function updateMobileTargetAccessibilityLabel(meterEl: HTMLElement): void {
  const targetEl = meterEl.querySelector<HTMLElement>(
    ".section-meter-mobile-current-section-target"
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
  updatePosition: (position: SectionMeterSettings["mobileMeterPosition"]) => void
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
  meterEl.addEventListener("click", (event) => {
    event.stopPropagation();
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const actionEl = (event.target as Element).closest<HTMLElement>(
      "[data-mobile-meter-action]"
    );
    if (actionEl?.dataset.mobileMeterAction === "supplemental") {
      meterEl.dataset.supplementalMetric = meterEl.dataset.supplementalMetric
        === meterEl.dataset.supplementalPrimaryMetric
        ? meterEl.dataset.supplementalSecondaryMetric
        : meterEl.dataset.supplementalPrimaryMetric;
      updateMobileSupplementalMetric(meterEl);
      return;
    }

    if (actionEl?.dataset.mobileMeterAction === "target") {
      meterEl.dataset.displayMode = meterEl.dataset.displayMode === "count"
        ? "percentage"
        : "count";
      updateMobileTargetAccessibilityLabel(meterEl);
    }
  }, true);
}

class ReadingTimeWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly wordCount: number,
    private readonly characterCount: number,
    private readonly seconds: number,
    private readonly target: WritingTargetProgress | null,
    private readonly scopeLabel: string
  ) {
    super();
  }

  eq(other: ReadingTimeWidget): boolean {
    return this.label === other.label
      && this.wordCount === other.wordCount
      && this.characterCount === other.characterCount
      && this.seconds === other.seconds
      && targetProgressesEqual(this.target, other.target)
      && this.scopeLabel === other.scopeLabel;
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
      this.scopeLabel
    );
  }

  get editable(): boolean {
    return true;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class SectionMeterSettingTab extends PluginSettingTab {
  private previewEl: HTMLElement | null = null;
  private badgePreviewValueEl: HTMLElement | null = null;
  private statusBarPreviewContentEl: HTMLElement | null = null;

  constructor(app: App, private readonly plugin: SectionMeterPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.getPreviewSettings(),
      this.createToggleSetting(
        "Keep live preview visible",
        "Keep the preview pinned while you scroll through the settings.",
        () => this.plugin.settings.previewSticky,
        async (value) => {
          this.plugin.settings.previewSticky = value;
          await this.plugin.saveSettings();
          this.updatePreviewSticky();
        }
      ),
      this.createBuildInfoSetting(),
      this.getBadgeDisplaySettings(),
      this.getCountingRuleSettings(),
      this.getStatusBarSettings(),
      this.getMobileSettings(),
      this.getWritingTargetSettings()
    ];
  }

  private getPreviewSettings(): SettingDefinitionGroup {
    return {
      type: "group",
      cls: "section-meter-settings-preview-group",
      items: [this.createDisplayPreviewSetting()]
    };
  }

  private getBadgeDisplaySettings(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Badge display",
      items: [
        this.createToggleSetting(
          "Show heading stats",
          "Show section stats beside Markdown headings.",
          () => this.plugin.settings.showHeadingStats,
          async (value) => {
            this.plugin.settings.showHeadingStats = value;
            await this.plugin.saveSettings();
          }
        ),
        this.createToggleSetting(
          "Show inline title stats",
          "Show whole-note stats beside the inline note title.",
          () => this.plugin.settings.showInlineTitleStats,
          async (value) => {
            this.plugin.settings.showInlineTitleStats = value;
            await this.plugin.saveSettings();
          }
        ),
        this.createToggleSetting(
          "Word count",
          "Show readable word counts in heading and title badges.",
          () => this.plugin.settings.showWords,
          async (value) => {
            this.plugin.settings.showWords = value;
            await this.plugin.saveSettings();
          },
          { updatePreviewAfterChange: true }
        ),
        this.createToggleSetting(
          "Reading time",
          "Show estimated reading time in heading and title badges.",
          () => this.plugin.settings.showTiming,
          async (value) => {
            this.plugin.settings.showTiming = value;
            await this.plugin.saveSettings();
          },
          { updatePreviewAfterChange: true }
        ),
        this.createToggleSetting(
          "Character count",
          "Show readable character counts in heading and title badges.",
          () => this.plugin.settings.showCharacters,
          async (value) => {
            this.plugin.settings.showCharacters = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true }
        ),
        this.createToggleSetting(
          "Compact mode",
          "Use shorter labels like 640w, 3200 chars, and 3m/49s in heading badges, title badges, and the status bar.",
          () => this.plugin.settings.compactMode,
          async (value) => {
            this.plugin.settings.compactMode = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true }
        ),
        this.createTextSetting(
          "Compact words label",
          "Suffix used for word counts in compact mode. Defaults to w.",
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
          "Label used for character counts in compact mode. Defaults to char.",
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
          "Suffix used for minute estimates in compact mode. Defaults to m.",
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
          "Single character used between enabled badge label parts.",
          DEFAULT_SETTINGS.labelSeparator,
          () => this.plugin.settings.labelSeparator,
          async (value) => {
            this.plugin.settings.labelSeparator = normalizeSeparator(value);
            await this.plugin.saveSettings();
          },
          { updatePreviewAfterChange: true }
        ),
        this.createTextSetting(
          "Minimum word count",
          "Hide badges for sections below this word count. Use 0 to show all headings.",
          String(DEFAULT_SETTINGS.minimumWordCount),
          () => String(this.plugin.settings.minimumWordCount),
          async (value) => {
            this.plugin.settings.minimumWordCount = parseNonNegativeInteger(
              value,
              DEFAULT_SETTINGS.minimumWordCount
            );
            await this.plugin.saveSettings();
          }
        ),
        this.createToggleSetting(
          "Hide empty sections",
          "Hide badges for headings with no readable words below them.",
          () => this.plugin.settings.hideEmptySections,
          async (value) => {
            this.plugin.settings.hideEmptySections = value;
            await this.plugin.saveSettings();
          }
        )
      ]
    };
  }

  private getCountingRuleSettings(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Counting rules",
      items: [
        this.createReadingSpeedSetting(),
        this.createToggleSetting(
          "Count spaces",
          "Count normalized spaces between words in character counts.",
          () => this.plugin.settings.countCharactersWithSpaces,
          async (value) => {
            this.plugin.settings.countCharactersWithSpaces = value;
            await this.plugin.saveSettings();
          },
          {
            disabled: () => !this.plugin.settings.showCharacters
              && !this.plugin.settings.showStatusBarCharacters
          }
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
        this.createToggleSetting(
          "Word count",
          "Show word counts in the status bar.",
          () => this.plugin.settings.showStatusBarWords,
          async (value) => {
            this.plugin.settings.showStatusBarWords = value;
            await this.plugin.saveSettings();
          },
          { updatePreviewAfterChange: true }
        ),
        this.createToggleSetting(
          "Reading time",
          "Show estimated reading time in the status bar.",
          () => this.plugin.settings.showStatusBarTiming,
          async (value) => {
            this.plugin.settings.showStatusBarTiming = value;
            await this.plugin.saveSettings();
          },
          { updatePreviewAfterChange: true }
        ),
        this.createToggleSetting(
          "Character count",
          "Show readable character counts in the status bar.",
          () => this.plugin.settings.showStatusBarCharacters,
          async (value) => {
            this.plugin.settings.showStatusBarCharacters = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true }
        )
      ]
    };
  }

  private getMobileSettings(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Mobile",
      items: [
        this.createToggleSetting(
          "Sticky current-section meter (Beta)",
          "Beta: show writing-target progress while scrolling in the mobile editor. Tap the meter to switch between percentage and count.",
          () => this.plugin.settings.mobileStickySectionMeter,
          async (value) => {
            this.plugin.settings.mobileStickySectionMeter = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true }
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
            await this.plugin.saveSettings();
          },
          { visible: () => this.plugin.settings.mobileStickySectionMeter }
        )
      ]
    };
  }

  private getWritingTargetSettings(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Writing targets",
      items: [
        this.createGuidanceSetting(
          "Supported target formats",
          "Examples: Target: 250 words, Target: 1800 characters, Target: 3m, Target: 2m 30s."
        ),
        this.createDropdownSetting(
          "Progress label",
          "Show target progress as a count or as a percentage.",
          () => this.plugin.settings.targetProgressLabelStyle,
          {
            count: "Count (n/N)",
            percentage: "Percentage"
          },
          async (value) => {
            this.plugin.settings.targetProgressLabelStyle =
              normalizeTargetProgressLabelStyle(value);
            await this.plugin.saveSettings();
          }
        ),
        this.createSliderSetting(
          "Overage warning threshold",
          "Turn target progress red when it reaches this percentage of the target.",
          MIN_TARGET_OVERAGE_WARNING_PERCENT,
          MAX_TARGET_OVERAGE_WARNING_PERCENT,
          TARGET_OVERAGE_WARNING_PERCENT_STEP,
          () => this.plugin.settings.targetOverageWarningPercent,
          async (value) => {
            this.plugin.settings.targetOverageWarningPercent = value;
            await this.plugin.saveSettings();
          }
        )
      ]
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
        const settings = this.plugin.settings;
        const previewEl = setting.settingEl.createDiv({
          cls: "section-meter-settings-preview"
        });

        previewEl.createDiv({
          cls: "section-meter-settings-preview-heading",
          text: "Live preview"
        });
        const examplesEl = previewEl.createDiv({
          cls: "section-meter-settings-preview-examples"
        });

        const badgePreview = createSettingsHeadingPreview(settings);
        this.badgePreviewValueEl = badgePreview.valueEl;
        examplesEl.appendChild(badgePreview.el);

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
  note: ReturnType<typeof summarizeNoteReadingTime>
): StatusBarStats {
  const sectionTarget = getSectionTargetAtSelection(view, summaries);
  const selectedRanges = view.state.selection.ranges.filter((range) => !range.empty);
  if (selectedRanges.length === 0) {
    return {
      note,
      selection: null,
      sectionTarget
    };
  }

  const selectedText = selectedRanges
    .map((range) => view.state.sliceDoc(range.from, range.to))
    .join("\n")
    .trim();

  if (!selectedText) {
    return {
      note,
      selection: null,
      sectionTarget
    };
  }

  const selection = summarizeNoteReadingTime(selectedText, settings);
  if (selection.wordCount === 0 && selection.characterCount === 0) {
    return {
      note,
      selection: null,
      sectionTarget
    };
  }

  return {
    note,
    selection: {
      ...selection,
      target: null
    },
    sectionTarget
  };
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
    minimumWordCount: parseNonNegativeInteger(
      settings.minimumWordCount,
      DEFAULT_SETTINGS.minimumWordCount
    ),
    hideEmptySections: normalizeBoolean(
      settings.hideEmptySections,
      DEFAULT_SETTINGS.hideEmptySections
    ),
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

function createReadingTimeBadge(
  label: string,
  wordCount: number,
  characterCount: number,
  seconds: number,
  target: WritingTargetProgress | null,
  extraClass = "",
  selectOnClick = false,
  scopeLabel = "Reading stats"
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
    badge.appendChild(createBadgeTargetGroupEl(target));
  }

  badge.setAttribute(
    "aria-label",
    target
      ? `${scopeLabel}: ${label}, target ${target.label}, ${Math.round(target.percent)}% of target`
      : `${scopeLabel}: ${wordCount} ${wordCount === 1 ? "word" : "words"}, ${characterCount} ${characterCount === 1 ? "character" : "characters"}, ${formatDurationForLabel(seconds)} read`
  );
  badge.setAttribute("title", scopeLabel);
  badge.setAttribute("spellcheck", "false");
  badge.addEventListener("beforeinput", (event) => event.preventDefault());
  badge.addEventListener("keydown", preventBadgeTextEdit);
  badge.addEventListener("mousedown", stopEditorMouseHandling);
  badge.addEventListener("pointerdown", stopEditorMouseHandling);

  if (selectOnClick) {
    badge.addEventListener("click", (event) => {
      event.stopPropagation();
      selectBadgeText(badge);
    });
  }

  return badge;
}

function createBadgeTargetGroupEl(target: WritingTargetProgress): HTMLElement {
  const groupEl = createSpan();
  groupEl.className = "section-meter-target-group";

  const captionEl = createSpan();
  captionEl.className = "section-meter-target-caption";
  captionEl.textContent = "Target";
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
  labelEl.className = "section-meter-target-label";
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
  fillEl.style.width = `${Math.min(100, Math.max(0, target.percent))}%`;
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

function selectBadgeText(badge: HTMLElement) {
  const selection = activeWindow.getSelection();
  if (!selection) {
    return;
  }

  const range = activeDocument.createRange();
  range.selectNodeContents(badge);
  selection.removeAllRanges();
  selection.addRange(range);
}

function preventBadgeTextEdit(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }

  const editingKeys = new Set([
    "Backspace",
    "Delete",
    "Enter",
    "Tab"
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
  return value === "percentage" ? "percentage" : DEFAULT_SETTINGS.targetProgressLabelStyle;
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
