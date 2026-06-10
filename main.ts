import { Compartment, Extension, RangeSetBuilder } from "@codemirror/state";
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
  MarkdownView,
  Plugin,
  PluginSettingTab
} from "obsidian";
import type {
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionItem
} from "obsidian";
import {
  SectionMeterSettings,
  SectionMeterSummary,
  LegacyLabelStyle,
  WritingTargetProgress,
  formatReadingTime,
  shouldShowSummary,
  summarizeNoteReadingTime,
  summarizeSectionReadingTimes
} from "./src/readingTime";

const DEFAULT_SETTINGS: SectionMeterSettings = {
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
  targetProgressLabelStyle: "count"
};
const MIN_WORDS_PER_MINUTE = 100;
const MAX_WORDS_PER_MINUTE = 500;
const WORDS_PER_MINUTE_STEP = 10;
const MIN_TARGET_OVERAGE_WARNING_PERCENT = 100;
const MAX_TARGET_OVERAGE_WARNING_PERCENT = 200;
const TARGET_OVERAGE_WARNING_PERCENT_STEP = 5;
const SELECTION_BADGE_UPDATE_DELAY_MS = 220;

type StoredSettings = Partial<Record<keyof SectionMeterSettings, unknown>> & {
  labelStyle?: unknown;
};

export default class SectionMeterPlugin extends Plugin {
  settings: SectionMeterSettings = DEFAULT_SETTINGS;
  private extensionCompartment = new Compartment();
  private statusBarItem: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.classList.add("section-meter-status-bar");
    this.clearStatusBar();

    this.registerEditorExtension(
      this.extensionCompartment.of(createSectionMeterExtension(
        () => this.settings,
        (status) => this.updateStatusBar(status)
      ))
    );
    this.addSettingTab(new SectionMeterSettingTab(this.app, this));
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
        if (info instanceof MarkdownView) {
          this.refreshTitleBadge(info);
          this.refreshStatusBarFromActiveView();
        }
      })
    );
    this.app.workspace.onLayoutReady(() => {
      this.refreshTitleBadges();
      this.refreshStatusBarFromActiveView();
    });
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

  private refreshEditorExtensions() {
    const extension = createSectionMeterExtension(
      () => this.settings,
      (status) => this.updateStatusBar(status)
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
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      this.clearStatusBar();
      return;
    }

    const editorView = getEditorView(activeView);
    if (editorView) {
      this.updateStatusBar(getStatusBarStats(
        editorView,
        this.settings,
        summarizeSectionReadingTimes(editorView.state.doc.toString(), this.settings)
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

  private refreshTitleBadge(markdownView: MarkdownView) {
    const container = markdownView.containerEl;
    container
      .querySelectorAll(".section-meter-title-badge")
      .forEach((badge) => badge.remove());
    container
      .querySelectorAll(".section-meter-title-row")
      .forEach((row) => row.classList.remove("section-meter-title-row"));

    const titleEl = container.querySelector<HTMLElement>(".inline-title");
    const titleRow = titleEl?.parentElement;
    if (!titleEl || !titleRow) {
      return;
    }

    const summary = summarizeNoteReadingTime(markdownView.getViewData(), this.settings);
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
    titleRow.classList.add("section-meter-title-row");
    titleEl.insertAdjacentElement("afterend", badge);
  }

  private updateStatusBar(status: StatusBarStats | null) {
    if (!this.statusBarItem) {
      return;
    }

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
    this.statusBarItem.setAttribute("title", "Section Meter");
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
  }
}

function createSectionMeterExtension(
  getSettings: () => SectionMeterSettings,
  updateStatusBar: (status: StatusBarStats | null) => void
): Extension {
  class SectionMeterViewPlugin implements PluginValue {
    decorations: DecorationSet;
    private summaries: SectionMeterSummary[];
    private selectionBadgeUpdateTimer: number | null = null;
    private selectionBadgeRefreshQueued = false;
    private applySelectionBadgeOverride = true;

    constructor(view: EditorView) {
      this.summaries = summarizeSectionReadingTimes(view.state.doc.toString(), getSettings());
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.summaries = summarizeSectionReadingTimes(update.state.doc.toString(), getSettings());
      }

      let shouldRebuildDecorations = update.docChanged || update.viewportChanged;
      if (this.selectionBadgeRefreshQueued) {
        this.selectionBadgeRefreshQueued = false;
        this.applySelectionBadgeOverride = true;
        shouldRebuildDecorations = true;
      }

      if (update.selectionSet || update.focusChanged) {
        this.applySelectionBadgeOverride = false;
        this.queueSelectionBadgeRefresh(update.view);
        shouldRebuildDecorations = true;
      }

      if (shouldRebuildDecorations) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    destroy() {
      if (this.selectionBadgeUpdateTimer !== null) {
        activeWindow.clearTimeout(this.selectionBadgeUpdateTimer);
      }

      this.summaries = [];
    }

    private queueSelectionBadgeRefresh(view: EditorView) {
      if (this.selectionBadgeUpdateTimer !== null) {
        activeWindow.clearTimeout(this.selectionBadgeUpdateTimer);
      }

      this.selectionBadgeUpdateTimer = activeWindow.setTimeout(() => {
        this.selectionBadgeUpdateTimer = null;
        this.selectionBadgeRefreshQueued = true;
        view.dispatch({});
      }, SELECTION_BADGE_UPDATE_DELAY_MS);
    }

    private buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const settings = getSettings();
      const statusBarStats = getStatusBarStats(view, settings, this.summaries);
      const selectionOverride = this.applySelectionBadgeOverride && statusBarStats.selection
        ? getHeadingSelectionOverride(view, this.summaries, statusBarStats.selection)
        : null;
      updateStatusBar(statusBarStats);

      for (const summary of this.summaries) {
        if (!isPositionVisible(summary.headingEnd, view.visibleRanges)) {
          continue;
        }

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
  }

  return ViewPlugin.fromClass(SectionMeterViewPlugin, {
    decorations: (plugin) => plugin.decorations
  });
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
  constructor(app: App, private readonly plugin: SectionMeterPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.getBadgeDisplaySettings(),
      this.getCountingRuleSettings(),
      this.getStatusBarSettings(),
      this.getWritingTargetSettings()
    ];
  }

  private getBadgeDisplaySettings(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Badge Display",
      items: [
        this.createToggleSetting(
          "Word count",
          "Show readable word counts in heading and title badges.",
          () => this.plugin.settings.showWords,
          async (value) => {
            this.plugin.settings.showWords = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true }
        ),
        this.createToggleSetting(
          "Reading time",
          "Show estimated reading time in heading and title badges.",
          () => this.plugin.settings.showTiming,
          async (value) => {
            this.plugin.settings.showTiming = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true }
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
        this.createTextSetting(
          "Separator",
          "Single character used between enabled badge label parts.",
          DEFAULT_SETTINGS.labelSeparator,
          () => this.plugin.settings.labelSeparator,
          async (value) => {
            this.plugin.settings.labelSeparator = normalizeSeparator(value);
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true }
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
      heading: "Counting Rules",
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
      heading: "Status Bar",
      items: [
        this.createToggleSetting(
          "Whole note",
          "Show whole-note stats in Obsidian's bottom status bar.",
          () => this.plugin.settings.showStatusBarNoteStats,
          async (value) => {
            this.plugin.settings.showStatusBarNoteStats = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true }
        ),
        this.createToggleSetting(
          "Selection",
          "Show selected-text stats in Obsidian's bottom status bar.",
          () => this.plugin.settings.showStatusBarSelectionStats,
          async (value) => {
            this.plugin.settings.showStatusBarSelectionStats = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true }
        ),
        this.createToggleSetting(
          "Word count",
          "Show word counts in the status bar.",
          () => this.plugin.settings.showStatusBarWords,
          async (value) => {
            this.plugin.settings.showStatusBarWords = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true }
        ),
        this.createToggleSetting(
          "Reading time",
          "Show estimated reading time in the status bar.",
          () => this.plugin.settings.showStatusBarTiming,
          async (value) => {
            this.plugin.settings.showStatusBarTiming = value;
            await this.plugin.saveSettings();
          },
          { updateAfterChange: true }
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

  private getWritingTargetSettings(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Writing Targets",
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
      render: (setting) => {
        const readingSpeedGuidanceEl = activeDocument.createElement("div");
        readingSpeedGuidanceEl.className = "section-meter-setting-guidance";
        readingSpeedGuidanceEl.textContent = getReadingSpeedGuidance(
          this.plugin.settings.wordsPerMinute
        );

        setting
          .setName("Reading speed")
          .setDesc("Words per minute used to estimate reading time.")
          .then((setting) => {
            setting.descEl.appendChild(readingSpeedGuidanceEl);
          })
          .addSlider((slider) => slider
            .setLimits(MIN_WORDS_PER_MINUTE, MAX_WORDS_PER_MINUTE, WORDS_PER_MINUTE_STEP)
            .setValue(this.plugin.settings.wordsPerMinute)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.wordsPerMinute = value;
              readingSpeedGuidanceEl.textContent = getReadingSpeedGuidance(value);
              await this.plugin.saveSettings();
            }));
      }
    };
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
      render: (setting) => {
        setting
          .setName(name)
          .setDesc(desc)
          .addToggle((toggle) => toggle
            .setValue(getValue())
            .setDisabled(options.disabled?.() ?? false)
            .onChange(async (value) => {
              await onChange(value);
              if (options.updateAfterChange) {
                this.update();
              }
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
      render: (setting) => {
        setting
          .setName(name)
          .setDesc(desc)
          .addText((text) => text
            .setPlaceholder(placeholder)
            .setValue(getValue())
            .onChange(async (value) => {
              await onChange(value);
              if (options.updateAfterChange) {
                this.update();
              }
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
    onChange: (value: number) => void | Promise<void>
  ): SettingDefinition {
    return {
      name,
      desc,
      render: (setting) => {
        setting
          .setName(name)
          .setDesc(desc)
          .addSlider((slider) => slider
            .setLimits(min, max, step)
            .setValue(getValue())
            .setDynamicTooltip()
            .onChange(onChange));
      }
    };
  }

  private createDropdownSetting(
    name: string,
    desc: string,
    getValue: () => string,
    options: Record<string, string>,
    onChange: (value: string) => void | Promise<void>
  ): SettingDefinition {
    return {
      name,
      desc,
      render: (setting) => {
        setting
          .setName(name)
          .setDesc(desc)
          .addDropdown((dropdown) => dropdown
            .addOptions(options)
            .setValue(getValue())
            .onChange(onChange));
      }
    };
  }

  private createGuidanceSetting(name: string, desc: string): SettingDefinition {
    return {
      name,
      desc,
      render: (setting) => {
        setting
          .setName(name)
          .setDesc(desc);
      }
    };
  }
}

type SettingRowOptions = {
  disabled?: () => boolean;
  updateAfterChange?: boolean;
};

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

function isPositionVisible(
  position: number,
  ranges: readonly { from: number; to: number }[]
): boolean {
  return ranges.some((range) => position >= range.from && position <= range.to);
}

function getStatusBarStats(
  view: EditorView,
  settings: SectionMeterSettings,
  summaries: SectionMeterSummary[]
): StatusBarStats {
  const note = summarizeNoteReadingTime(view.state.doc.toString(), settings);
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
  const targetSection = getSelectionTargetHeading(summaries, position, position);
  return targetSection?.target ?? null;
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
    wordsPerMinute: normalizeWordsPerMinute(settings.wordsPerMinute),
    ...displaySettings,
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
    )
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
  const badge = activeDocument.createElement("span");
  badge.className = ["section-meter-badge", extraClass].filter(Boolean).join(" ");
  const labelEl = activeDocument.createElement("span");
  labelEl.className = "section-meter-badge-label";
  labelEl.textContent = label;
  badge.appendChild(labelEl);

  if (target) {
    badge.classList.add("section-meter-target-badge");
    badge.classList.add(getTargetProgressStateClass(target));
    badge.appendChild(createInlineTargetSeparatorEl());
    badge.appendChild(createTargetLabelEl(target));
    badge.appendChild(createTargetProgressEl(target));
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

function createStatusBarStatsEl(
  scopeLabel: string,
  stats: SelectionStats,
  settings: SectionMeterSettings
): HTMLElement {
  const wrapper = activeDocument.createElement("span");
  wrapper.className = "section-meter-status-bar-part";

  const labelEl = activeDocument.createElement("span");
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
  const wrapper = activeDocument.createElement("span");
  wrapper.className = "section-meter-status-bar-part section-meter-status-bar-target";

  const targetTextEl = createTargetLabelEl(target);
  targetTextEl.classList.add("section-meter-status-bar-target-label");
  targetTextEl.textContent = formatTargetProgressForStatus(target);
  wrapper.appendChild(targetTextEl);
  wrapper.appendChild(createTargetProgressEl(target));

  return wrapper;
}

function createStatusBarSeparatorEl(): HTMLElement {
  const separator = activeDocument.createElement("span");
  separator.className = "section-meter-status-bar-separator";
  separator.textContent = "|";
  return separator;
}

function createTargetLabelEl(target: WritingTargetProgress): HTMLElement {
  const labelEl = activeDocument.createElement("span");
  labelEl.className = "section-meter-target-label";
  labelEl.textContent = target.label;
  return labelEl;
}

function createInlineTargetSeparatorEl(): HTMLElement {
  const separator = activeDocument.createElement("span");
  separator.className = "section-meter-target-separator";
  separator.textContent = "|";
  return separator;
}

function createTargetProgressEl(target: WritingTargetProgress): HTMLElement {
  const progressEl = activeDocument.createElement("span");
  progressEl.className = [
    "section-meter-target-progress",
    getTargetProgressStateClass(target)
  ].join(" ");
  progressEl.setAttribute("aria-hidden", "true");

  const fillEl = activeDocument.createElement("span");
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

function parseNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function getEditorView(markdownView: MarkdownView): EditorView | null {
  const editor = markdownView.editor as unknown as { cm?: EditorView };
  return editor.cm ?? null;
}
