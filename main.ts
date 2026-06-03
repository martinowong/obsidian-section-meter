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
  PluginSettingTab,
  Setting
} from "obsidian";
import {
  SectionMeterSettings,
  SectionMeterSummary,
  LegacyLabelStyle,
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
  showFloatingSelectionBadge: true
};
const MIN_WORDS_PER_MINUTE = 100;
const MAX_WORDS_PER_MINUTE = 500;
const WORDS_PER_MINUTE_STEP = 10;

type StoredSettings = Partial<SectionMeterSettings> & {
  labelStyle?: LegacyLabelStyle;
};

export default class SectionMeterPlugin extends Plugin {
  settings: SectionMeterSettings = DEFAULT_SETTINGS;
  private extensionCompartment = new Compartment();

  async onload() {
    await this.loadSettings();

    this.registerEditorExtension(
      this.extensionCompartment.of(createSectionMeterExtension(() => this.settings))
    );
    this.addSettingTab(new SectionMeterSettingTab(this.app, this));
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refreshTitleBadges())
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.refreshTitleBadges())
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        if (info instanceof MarkdownView) {
          this.refreshTitleBadge(info);
        }
      })
    );
    this.app.workspace.onLayoutReady(() => this.refreshTitleBadges());
  }

  async loadSettings() {
    this.settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...(await this.loadData())
    });
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
    this.refreshEditorExtensions();
    this.refreshTitleBadges();
  }

  private refreshEditorExtensions() {
    const extension = createSectionMeterExtension(() => this.settings);

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
      "section-meter-title-badge",
      false,
      "Whole note stats"
    );
    titleRow.classList.add("section-meter-title-row");
    titleRow.appendChild(badge);
  }
}

function createSectionMeterExtension(
  getSettings: () => SectionMeterSettings
): Extension {
  class SectionMeterViewPlugin implements PluginValue {
    decorations: DecorationSet;
    private summaries: SectionMeterSummary[];
    private floatingSelectionBadge: HTMLElement | null = null;

    constructor(view: EditorView) {
      this.summaries = summarizeSectionReadingTimes(view.state.doc.toString(), getSettings());
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.summaries = summarizeSectionReadingTimes(update.state.doc.toString(), getSettings());
      }

      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    destroy() {
      this.summaries = [];
      this.removeFloatingSelectionBadge();
    }

    private buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const settings = getSettings();
      const selectionOverride = getHeadingSelectionOverride(view, this.summaries, settings);
      this.syncFloatingSelectionBadge(view, selectionOverride, settings);

      for (const summary of this.summaries) {
        if (!isPositionVisible(summary.headingEnd, view.visibleRanges)) {
          continue;
        }

        const isSelectionTarget = selectionOverride?.headingFrom === summary.from;
        if (!isSelectionTarget && !shouldShowSummary(summary, settings)) {
          continue;
        }

        const label = isSelectionTarget ? selectionOverride.label : summary.label;
        const wordCount = isSelectionTarget ? selectionOverride.wordCount : summary.wordCount;
        const characterCount = isSelectionTarget
          ? selectionOverride.characterCount
          : summary.characterCount;
        const seconds = isSelectionTarget ? selectionOverride.seconds : summary.seconds;
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
              scopeLabel
            ),
            side: 1
          })
        );
      }

      return builder.finish();
    }

    private syncFloatingSelectionBadge(
      view: EditorView,
      selectionOverride: SelectionOverride | null,
      settings: SectionMeterSettings
    ) {
      if (!settings.showFloatingSelectionBadge
        || !selectionOverride
        || isPositionVisible(selectionOverride.headingEnd, view.visibleRanges)
      ) {
        this.removeFloatingSelectionBadge();
        return;
      }

      if (!this.floatingSelectionBadge) {
        this.floatingSelectionBadge = createReadingTimeBadge(
          selectionOverride.label,
          selectionOverride.wordCount,
          selectionOverride.characterCount,
          selectionOverride.seconds,
          "section-meter-floating-selection-badge",
          true,
          "Selection stats"
        );
        view.dom.appendChild(this.floatingSelectionBadge);
      } else {
        updateReadingTimeBadge(
          this.floatingSelectionBadge,
          selectionOverride.label,
          selectionOverride.wordCount,
          selectionOverride.characterCount,
          selectionOverride.seconds,
          "Selection stats"
        );
      }
    }

    private removeFloatingSelectionBadge() {
      this.floatingSelectionBadge?.remove();
      this.floatingSelectionBadge = null;
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
    private readonly scopeLabel: string
  ) {
    super();
  }

  eq(other: ReadingTimeWidget): boolean {
    return this.label === other.label
      && this.wordCount === other.wordCount
      && this.characterCount === other.characterCount
      && this.seconds === other.seconds
      && this.scopeLabel === other.scopeLabel;
  }

  toDOM(): HTMLElement {
    return createReadingTimeBadge(
      this.label,
      this.wordCount,
      this.characterCount,
      this.seconds,
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const readingSpeedGuidanceEl = document.createElement("div");
    readingSpeedGuidanceEl.className = "section-meter-setting-guidance";
    readingSpeedGuidanceEl.textContent = getReadingSpeedGuidance(
      this.plugin.settings.wordsPerMinute
    );

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName("Badge labels")
      .setHeading();

    new Setting(containerEl)
      .setName("Word count")
      .setDesc("Show readable word counts in badges.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showWords)
        .onChange(async (value) => {
          this.plugin.settings.showWords = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Timing")
      .setDesc("Show estimated reading time in badges.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showTiming)
        .onChange(async (value) => {
          this.plugin.settings.showTiming = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Characters")
      .setDesc("Show readable character counts in badges.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showCharacters)
        .onChange(async (value) => {
          this.plugin.settings.showCharacters = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Include spaces")
      .setDesc("Count normalized spaces between words in character counts.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.countCharactersWithSpaces)
        .onChange(async (value) => {
          this.plugin.settings.countCharactersWithSpaces = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Separator")
      .setDesc("Single character used between enabled label parts.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.labelSeparator)
        .setValue(this.plugin.settings.labelSeparator)
        .onChange(async (value) => {
          this.plugin.settings.labelSeparator = normalizeSeparator(value);
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Minimum word count")
      .setDesc("Hide badges for sections below this word count. Use 0 to show all headings.")
      .addText((text) => text
        .setPlaceholder(String(DEFAULT_SETTINGS.minimumWordCount))
        .setValue(String(this.plugin.settings.minimumWordCount))
        .onChange(async (value) => {
          this.plugin.settings.minimumWordCount = parseNonNegativeInteger(
            value,
            DEFAULT_SETTINGS.minimumWordCount
          );
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Hide empty sections")
      .setDesc("Hide badges for headings with no readable words below them.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.hideEmptySections)
        .onChange(async (value) => {
          this.plugin.settings.hideEmptySections = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Selection stats")
      .setHeading();

    new Setting(containerEl)
      .setName("Floating selection badge")
      .setDesc("Show a floating badge when selected-text stats target an offscreen heading.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showFloatingSelectionBadge)
        .onChange(async (value) => {
          this.plugin.settings.showFloatingSelectionBadge = value;
          await this.plugin.saveSettings();
        }));
  }
}

type SelectionOverride = Pick<SectionMeterSummary, "wordCount" | "characterCount" | "seconds" | "label" | "headingEnd"> & {
  headingFrom: number;
};

function isPositionVisible(
  position: number,
  ranges: readonly { from: number; to: number }[]
): boolean {
  return ranges.some((range) => position >= range.from && position <= range.to);
}

function getHeadingSelectionOverride(
  view: EditorView,
  summaries: SectionMeterSummary[],
  settings: SectionMeterSettings
): SelectionOverride | null {
  const selectedRanges = view.state.selection.ranges.filter((range) => !range.empty);
  if (selectedRanges.length === 0) {
    return null;
  }

  const selectionFrom = Math.min(...selectedRanges.map((range) => range.from));
  const selectionTo = Math.max(...selectedRanges.map((range) => range.to));
  const selectedText = selectedRanges
    .map((range) => view.state.sliceDoc(range.from, range.to))
    .join("\n")
    .trim();

  if (!selectedText) {
    return null;
  }

  const targetHeading = getSelectionTargetHeading(summaries, selectionFrom, selectionTo);
  if (!targetHeading) {
    return null;
  }

  const selectionSummary = summarizeNoteReadingTime(selectedText, settings);
  return {
    headingFrom: targetHeading.from,
    headingEnd: targetHeading.headingEnd,
    wordCount: selectionSummary.wordCount,
    characterCount: selectionSummary.characterCount,
    seconds: selectionSummary.seconds,
    label: selectionSummary.label
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

  return {
    wordsPerMinute: normalizeWordsPerMinute(settings.wordsPerMinute),
    ...displaySettings,
    countCharactersWithSpaces:
      settings.countCharactersWithSpaces ?? DEFAULT_SETTINGS.countCharactersWithSpaces,
    labelSeparator: normalizeSeparator(settings.labelSeparator),
    minimumWordCount: parseNonNegativeInteger(
      settings.minimumWordCount,
      DEFAULT_SETTINGS.minimumWordCount
    ),
    hideEmptySections: Boolean(settings.hideEmptySections),
    showFloatingSelectionBadge:
      settings.showFloatingSelectionBadge ?? DEFAULT_SETTINGS.showFloatingSelectionBadge
  };
}

function createReadingTimeBadge(
  label: string,
  wordCount: number,
  characterCount: number,
  seconds: number,
  extraClass = "",
  selectOnClick = false,
  scopeLabel = "Reading stats"
): HTMLElement {
  const badge = document.createElement("span");
  badge.className = ["section-meter-badge", extraClass].filter(Boolean).join(" ");
  badge.textContent = label;
  badge.setAttribute(
    "aria-label",
    `${scopeLabel}: ${wordCount} ${wordCount === 1 ? "word" : "words"}, ${characterCount} ${characterCount === 1 ? "character" : "characters"}, ${formatDurationForLabel(seconds)} read`
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

function updateReadingTimeBadge(
  badge: HTMLElement,
  label: string,
  wordCount: number,
  characterCount: number,
  seconds: number,
  scopeLabel: string
) {
  badge.textContent = label;
  badge.setAttribute(
    "aria-label",
    `${scopeLabel}: ${wordCount} ${wordCount === 1 ? "word" : "words"}, ${characterCount} ${characterCount === 1 ? "character" : "characters"}, ${formatDurationForLabel(seconds)} read`
  );
  badge.setAttribute("title", scopeLabel);
}

function stopEditorMouseHandling(event: Event) {
  event.stopPropagation();
}

function selectBadgeText(badge: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
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

function normalizeDisplaySettings(settings: StoredSettings) {
  const legacy = settings.labelStyle;
  const migrated = legacy
    ? displaySettingsFromLegacyLabelStyle(legacy)
    : {
      showWords: settings.showWords ?? DEFAULT_SETTINGS.showWords,
      showTiming: settings.showTiming ?? DEFAULT_SETTINGS.showTiming,
      showCharacters: settings.showCharacters ?? DEFAULT_SETTINGS.showCharacters
    };

  if (!migrated.showWords && !migrated.showTiming && !migrated.showCharacters) {
    return {
      ...migrated,
      showTiming: true
    };
  }

  return migrated;
}

function normalizeSeparator(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.labelSeparator;
  }

  return Array.from(value.trim())[0] ?? DEFAULT_SETTINGS.labelSeparator;
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

function parseNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function getEditorView(markdownView: MarkdownView): EditorView | null {
  const editor = markdownView.editor as unknown as { cm?: EditorView };
  return editor.cm ?? null;
}
