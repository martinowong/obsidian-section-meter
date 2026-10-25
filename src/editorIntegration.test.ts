// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App, MarkdownPostProcessor, MarkdownPostProcessorContext, PluginManifest } from "obsidian";
import type { TargetCompletion } from "./targetCompletion";
import { readFileSync } from "node:fs";

const host = vi.hoisted(() => ({ extensions: [] as unknown[], tabs: [] as unknown[],
  processors: [] as MarkdownPostProcessor[], settingsUpdates: 0,
  menus: [] as { title: string; run: () => unknown }[][] }));

// Obsidian is the external host. CodeMirror and the plugin run unmocked.
vi.mock("obsidian", async () => ({
  editorLivePreviewField: (await import("@codemirror/state")).StateField.define({
    create: () => false, update: (value: boolean) => value
  }),
  setIcon: (parent: HTMLElement, iconId: string) => { parent.dataset.icon = iconId; },
  Plugin: class {
    constructor(public app: unknown) {}
    async loadData() { return {}; }
    async saveData() {}
    addStatusBarItem() {
      const item = document.createElement("div");
      document.body.append(item);
      return item;
    }
    registerEditorExtension(extension: unknown) { host.extensions.push(extension); }
    registerMarkdownPostProcessor(processor: MarkdownPostProcessor) { host.processors.push(processor); }
    registerEvent() {}
    addSettingTab(tab: unknown) { host.tabs.push(tab); }
    addCommand() {}
  },
  PluginSettingTab: class {
    update() { host.settingsUpdates++; }
  },
  Modal: class {},
  MarkdownView: class { getMode() { return "source"; } },
  MarkdownRenderChild: class {
    constructor(public containerEl: HTMLElement) {}
    onload() {}
    onunload() {}
    load() { this.onload(); }
    unload() { this.onunload(); }
  },
  Notice: class {},
  Setting: class {},
  TextComponent: class {},
  Menu: class {
    items: { title: string; run: () => unknown }[] = [];
    addItem(callback: (item: unknown) => void) {
      const entry = { title: "", run: () => {} };
      const item = { setTitle: (title: string) => { entry.title = title; return item; },
        setIcon: () => item, setWarning: () => item,
        onClick: (run: () => void) => { entry.run = run; return item; } };
      callback(item);
      this.items.push(entry);
      return this;
    }
    showAtPosition() { host.menus.push(this.items); return this; }
  }
}));
import SectionMeterPlugin, { createSectionMeterExtension, createWritingTargetPresetButtons, parseWritingTargetInput } from "../main";
import { MarkdownView, editorLivePreviewField } from "obsidian";

const editors: EditorView[] = [];

beforeEach(() => {
  vi.stubGlobal("createSpan", () => document.createElement("span"));
  vi.stubGlobal("createDiv", () => document.createElement("div"));
  vi.stubGlobal("activeDocument", document);
  vi.stubGlobal("activeWindow", window);
  Object.defineProperty(HTMLElement.prototype, "setCssProps", {
    configurable: true,
    value(this: HTMLElement, props: Record<string, string>) {
      for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
    }
  });
  Object.assign(HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); },
    addClass(this: HTMLElement, name: string) { this.classList.add(name); },
    removeClass(this: HTMLElement, name: string) { this.classList.remove(name); }
  });
  host.extensions.length = 0;
  host.tabs.length = 0;
  host.settingsUpdates = 0;
  host.processors.length = 0;
  host.menus.length = 0;
});

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function createEditor(doc: string, mobile = false, options: {
  isActive?: (view: EditorView) => boolean;
  status?: (status: unknown) => void;
  editTarget?: (view: EditorView, scope: "note" | "section", position: number) => void;
  reached?: (view: EditorView, completions: TargetCompletion[]) => void;
  documentIdentity?: () => string;
} = {}): EditorView {
  const settings = { ...new SectionMeterPlugin({} as App, {} as PluginManifest).settings, mobileStickySectionMeter: mobile };
  const editor = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [createSectionMeterExtension(
        () => settings, options.status ?? (() => {}), () => {},
        options.editTarget ?? (() => {}), () => {}, options.isActive,
        options.reached, options.documentIdentity
      )]
    })
  });
  editors.push(editor);
  return editor;
}

describe("editor badge integration", () => {
  it("opens a stats-only menu when tapping a heading's statistics, with or without a target", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const editor = createEditor("# Plain\nhello\n# Targeted\nTarget: 10 words\none two");
    const labels = editor.dom.querySelectorAll<HTMLElement>(".section-meter-badge-label");
    for (const label of labels) {
      label.click();
      expect(host.menus.at(-1)?.map((item) => item.title)).toEqual(["Copy statistics"]);
    }
    await host.menus.at(-1)![0].run();
    expect(writeText).toHaveBeenCalledWith(labels[1].textContent);
    expect(editor.state.doc.toString()).toBe("# Plain\nhello\n# Targeted\nTarget: 10 words\none two");
  });

  it("opens only target actions from the target portion and acts on its heading, not the cursor", () => {
    const editTarget = vi.fn();
    const markdown = "# First\nTarget: 10 words\none two\n# Second\nTarget: 20 words\nthree";
    const editor = createEditor(markdown, false, { editTarget });
    editor.dispatch({ selection: { anchor: markdown.length } });
    const target = editor.dom.querySelector<HTMLElement>(".section-meter-target-group")!;
    target.querySelector<HTMLElement>(".section-meter-target-progress-fill")!.click();
    expect(host.menus.at(-1)?.map((item) => item.title)).toEqual(["Edit target", "Remove target"]);
    host.menus.at(-1)![0].run();
    expect(editTarget).toHaveBeenCalledWith(editor, "section", 0);
    host.menus.at(-1)![1].run();
    expect(editor.state.doc.toString()).toBe("# First\none two\n# Second\nTarget: 20 words\nthree");
  });

  it("supports separate menus in Reading view and removes only that note's displayed target", async () => {
    let markdown = "# First\nTarget: 10 words\nhello\n# Second\nTarget: 20 words\nworld";
    const file = { path: "reading.md" };
    const app = { vault: {
      on: () => ({}), getFileByPath: () => file,
      process: async (_file: unknown, transform: (text: string) => string) => { markdown = transform(markdown); }
    }, workspace: {
      getLeavesOfType: () => [], getActiveViewOfType: () => null,
      on: () => ({}), onLayoutReady: () => {}
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    const chunk = document.createElement("div");
    chunk.innerHTML = '<h1 data-heading="First">First</h1>';
    document.body.append(chunk);
    const context: MarkdownPostProcessorContext = {
      docId: "reading-menu", sourcePath: file.path, frontmatter: null,
      getSectionInfo: () => ({ text: markdown, lineStart: 0, lineEnd: 0 }),
      addChild: (child) => child.load()
    };
    await host.processors[0](chunk, context);
    chunk.querySelector<HTMLElement>(".section-meter-badge-label")!.click();
    expect(host.menus.at(-1)?.map((item) => item.title)).toEqual(["Copy statistics"]);
    chunk.querySelector<HTMLElement>(".section-meter-target-caption")!.click();
    expect(host.menus.at(-1)?.map((item) => item.title)).toEqual(["Edit target", "Remove target"]);
    await host.menus.at(-1)![1].run();
    expect(markdown).toBe("# First\nhello\n# Second\nTarget: 20 words\nworld");
    plugin.onunload();
  });

  it("keeps menus current on reused editor widgets and rejects a stale removal", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const editor = createEditor("# Section\nTarget: 10 words\nhello");
    const badge = editor.dom.querySelector<HTMLElement>(".section-meter-badge")!;
    badge.querySelector<HTMLElement>(".section-meter-target-group")!.click();
    const staleRemove = host.menus.at(-1)![1].run;
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: " world" } });
    expect(editor.dom.querySelector(".section-meter-badge")).toBe(badge);
    staleRemove();
    expect(editor.state.doc.toString()).toContain("Target: 10 words");
    const stats = badge.querySelector<HTMLElement>(".section-meter-badge-label")!;
    stats.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await host.menus.at(-1)![0].run();
    expect(writeText).toHaveBeenCalledWith("2 words, 0m 01s");
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    stats.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    badge.querySelector<HTMLElement>(".section-meter-target-label")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(host.menus.at(-1)?.map((item) => item.title)).toEqual(["Edit target", "Remove target"]);
    host.menus.at(-1)![1].run();
    expect(editor.state.doc.toString()).toBe("# Section\nhello world");
  });

  it("does not remove a Reading view target if the note changes while its menu is open", async () => {
    let markdown = "# Section\nTarget: 10 words\nhello";
    const file = { path: "reading.md" };
    const app = { vault: {
      on: () => ({}), getFileByPath: () => file,
      process: async (_file: unknown, transform: (text: string) => string) => { markdown = transform(markdown); }
    }, workspace: {
      getLeavesOfType: () => [], getActiveViewOfType: () => null,
      on: () => ({}), onLayoutReady: () => {}
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    const chunk = document.createElement("div");
    chunk.innerHTML = "<h1>Section</h1>";
    document.body.append(chunk);
    await host.processors[0](chunk, {
      docId: "stale-menu", sourcePath: file.path, frontmatter: null,
      getSectionInfo: () => ({ text: markdown, lineStart: 0, lineEnd: 0 }),
      addChild: (child) => child.load()
    });
    chunk.querySelector<HTMLElement>(".section-meter-target-group")!.click();
    markdown += " world";
    await host.menus.at(-1)![1].run();
    expect(markdown).toBe("# Section\nTarget: 10 words\nhello world");
    plugin.onunload();
  });
  it("renders Reading view sections by source line, including repeated names and parent totals", async () => {
    const app = { vault: { on: () => ({}) }, workspace: {
      getLeavesOfType: () => [], getActiveViewOfType: () => null,
      on: () => ({}), onLayoutReady: () => {}
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    const markdown = "# Parent\nintro\n## Same\none two\n## Same\nTarget: 10 words\nthree four five";
    const children: import("obsidian").MarkdownRenderChild[] = [];
    const context = (line: number): MarkdownPostProcessorContext => ({
      docId: "reading-note", sourcePath: "note.md", frontmatter: null,
      getSectionInfo: () => ({ text: markdown, lineStart: line, lineEnd: line }),
      addChild: (child) => { children.push(child); child.load(); }
    });
    const chunks = [0, 2, 4].map((line, index) => {
      const chunk = document.createElement("div");
      const heading = document.createElement(index === 0 ? "h1" : "h2");
      heading.textContent = index === 0 ? "Parent" : "Same";
      heading.dataset.heading = heading.textContent;
      chunk.append(heading);
      document.body.append(chunk);
      host.processors[0](chunk, context(line));
      return chunk;
    });
    const labels = chunks.map((chunk) => chunk.querySelector(".section-meter-badge-label")?.textContent);
    expect(labels[0]).toContain("8 words");
    expect(labels[1]).toContain("2 words");
    expect(labels[2]).toContain("3 words");
    expect(chunks[2].querySelector(".section-meter-target-label")?.textContent).toContain("3 / 10");
    expect(chunks[1].querySelector("h2")?.dataset.heading).toBe("Same");
    await host.processors[0](chunks[1], context(2));
    expect(chunks[1].querySelectorAll(".section-meter-reading-badge")).toHaveLength(1);
    expect(children).toHaveLength(3);
    plugin.settings.showHeadingStats = false;
    await plugin.saveSettings();
    expect(document.querySelectorAll(".section-meter-reading-badge")).toHaveLength(0);
    plugin.settings.showHeadingStats = true;
    await plugin.saveSettings();
    expect(document.querySelectorAll(".section-meter-reading-badge")).toHaveLength(3);
    children[1].unload();
    expect(chunks[1].querySelector("h2")?.textContent).toBe("Same");
    plugin.onunload();
    expect(document.querySelectorAll(".section-meter-reading-badge")).toHaveLength(0);
  });

  it("refreshes retained Reading view headings when a prose chunk changes and preserves native links", async () => {
    const app = { vault: { on: () => ({}) }, workspace: {
      getLeavesOfType: () => [], getActiveViewOfType: () => null,
      on: () => ({}), onLayoutReady: () => {}
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    let markdown = "# Linked\nhello";
    let available = true;
    const context: MarkdownPostProcessorContext = {
      docId: "changing-note", sourcePath: "changing.md", frontmatter: null,
      getSectionInfo: () => available ? { text: markdown, lineStart: 0, lineEnd: 0 } : null,
      addChild: (child) => child.load()
    };
    const chunk = document.createElement("div");
    chunk.innerHTML = '<h1 data-heading="Linked"><a href="other.md">Linked</a></h1>';
    document.body.append(chunk);
    const link = chunk.querySelector("a");
    await host.processors[0](chunk, context);
    const badge = chunk.querySelector(".section-meter-reading-badge");
    await host.processors[0](document.createElement("p"), context);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(chunk.querySelector(".section-meter-reading-badge")).toBe(badge);
    markdown += " world";
    await host.processors[0](document.createElement("p"), context);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(chunk.querySelector(".section-meter-badge-label")?.textContent).toContain("2 words");
    expect(chunk.querySelector("a")).toBe(link);
    expect(link?.getAttribute("href")).toBe("other.md");
    available = false;
    await plugin.saveSettings();
    expect(chunk.querySelector(".section-meter-reading-badge")).toBeNull();
    available = true;
    plugin.settings.minimumWordCount = 100;
    await plugin.saveSettings();
    expect(chunk.querySelector(".section-meter-reading-badge")).toBeNull();
    markdown = "# Linked\nTarget: 10 words\nhello";
    await plugin.saveSettings();
    expect(chunk.querySelector(".section-meter-target-badge")).not.toBeNull();
    plugin.settings.enabled = false;
    await plugin.saveSettings();
    expect(chunk.querySelector(".section-meter-reading-badge")).toBeNull();
    plugin.onunload();
    expect(chunk.querySelector("h1")?.innerHTML).toBe('<a href="other.md">Linked</a>');
  });

  it("uses Reading-view content for title and status stats rather than a hidden editor's cached document", async () => {
    let active: MarkdownView | null = null;
    let ready: () => void = () => {};
    const app = { vault: { on: () => ({}) }, workspace: {
      getLeavesOfType: () => active ? [{ view: active }] : [],
      getActiveViewOfType: () => active, on: () => ({}),
      onLayoutReady: (callback: () => void) => { ready = callback; }
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    const editor = new EditorView({ parent: document.body, state: EditorState.create({
      doc: "old", extensions: host.extensions as Extension[]
    }) });
    editors.push(editor);
    const container = document.createElement("div");
    container.innerHTML = '<div class="markdown-preview-view"><div><div class="inline-title">Note</div></div></div>';
    document.body.append(container);
    active = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      containerEl: container, getViewData: () => "hello world", getMode: () => "preview",
      editor: { cm: editor }, previewMode: { rerender: () => {} }
    });
    ready();
    expect(container.querySelector(".section-meter-badge-label")?.textContent).toContain("2 words");
    expect(document.querySelector(".section-meter-status-bar")?.textContent).toContain("Note: 2 words");
    expect(container.querySelector(".inline-title")?.textContent).toBe("Note");
    const context: MarkdownPostProcessorContext = {
      docId: "note", sourcePath: "note.md", frontmatter: null,
      getSectionInfo: () => ({ text: "hello world", lineStart: 0, lineEnd: 0 }),
      addChild: (child) => child.load()
    };
    await host.processors[0](document.createElement("p"), context);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const badge = container.querySelector(".section-meter-title-badge");
    await host.processors[0](document.createElement("p"), context);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(container.querySelector(".section-meter-title-badge")).toBe(badge);
    plugin.onunload();
  });

  it("keeps editor UI in place when saving a preview-only preference", async () => {
    let active: MarkdownView | null = null;
    const app = { vault: { on: () => ({}) }, workspace: {
      getLeavesOfType: () => active ? [{ view: active }] : [],
      getActiveViewOfType: () => active,
      on: () => ({}), onLayoutReady: () => {}
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    plugin.settings.mobileStickySectionMeter = true;
    const editor = new EditorView({ parent: document.body, state: EditorState.create({
      doc: "# Section\nTarget: 10 words\nhello",
      extensions: host.extensions as Extension[]
    }) });
    editors.push(editor);
    active = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      editor: { cm: editor }, containerEl: editor.dom
    });
    const meter = editor.dom.querySelector(".section-meter-mobile-current-section");
    plugin.settings.previewSticky = false;
    await plugin.saveSettings({ refreshStats: false });
    expect(meter?.isConnected).toBe(true);
    expect(editor.dom.querySelector(".section-meter-mobile-current-section")).toBe(meter);
    plugin.onunload();
  });

  it("switches progress colours with the classic setting and cleans up on unload", async () => {
    const app = { vault: { on: () => ({}) }, workspace: {
      getLeavesOfType: () => [], getActiveViewOfType: () => null,
      on: () => ({}), onLayoutReady: () => {}
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    const isClassic = () => document.body.classList.contains("section-meter-classic-target-colors");
    expect(isClassic()).toBe(false);

    plugin.settings.classicTargetColors = true;
    await plugin.saveSettings({ refreshStats: false });
    expect(isClassic()).toBe(true);

    plugin.onunload();
    expect(isClassic()).toBe(false);
  });

  it("marks target labels with their progress state for colours and the reached check", () => {
    const editor = createEditor("# Done\nTarget: 2 words\none two\n# Over\nTarget: 2 words\none two three");
    const labels = [...editor.dom.querySelectorAll(".section-meter-badge .section-meter-target-label")];
    expect(labels.map((label) => label.classList.contains("section-meter-target-complete"))).toEqual([true, false]);
    expect(labels.map((label) => label.classList.contains("section-meter-target-overage"))).toEqual([false, true]);
  });

  it("shows valid target lines as chips in Live Preview without changing the Markdown", () => {
    const doc = "# Draft\nTarget: 250 words\nTarget: 500\n```\nTarget: 9 words\n```\nHello";
    const createChipEditor = (livePreview: boolean, showTargetChips = true) => {
      const editor = new EditorView({ parent: document.body, state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [editorLivePreviewField.init(() => livePreview),
          createSectionMeterExtension(() => ({ ...new SectionMeterPlugin({} as App, {} as PluginManifest).settings, showTargetChips }),
            () => {}, () => {}, () => {}, () => {})]
      }) });
      editors.push(editor);
      return editor;
    };
    const chipValues = (editor: EditorView) => [...editor.dom.querySelectorAll(".section-meter-target-chip-value")]
      .map((chip) => chip.textContent);

    expect(chipValues(createChipEditor(false))).toEqual([]);
    expect(chipValues(createChipEditor(true, false))).toEqual([]);
    const editor = createChipEditor(true);
    expect(chipValues(editor)).toEqual(["250 words"]);

    editor.dom.querySelector<HTMLElement>(".section-meter-target-chip")!.click();
    expect(editor.state.selection.main.head).toBe(editor.state.doc.line(2).to);
    expect(chipValues(editor)).toEqual([]);
    expect(editor.state.doc.toString()).toBe(doc);

    editor.dispatch({ selection: { anchor: doc.length } });
    expect(chipValues(editor)).toEqual(["250 words"]);
  });

  it("seeds a new file even when it shares the previous note's exact content", () => {
    let identity = "first.md";
    const reached = vi.fn();
    const editor = createEditor("# Section\nTarget: 3 words\none two", false, {
      reached, documentIdentity: () => identity
    });
    identity = "second.md";
    editor.dispatch({});
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: " three" } });
    expect(reached).toHaveBeenCalledTimes(1);
    expect(editor.dom.querySelectorAll(".section-meter-badge")).toHaveLength(1);
  });

  it("refreshes metric controls when disabling the last badge metric enables the fallback", async () => {
    const app = { vault: { on: () => ({}) }, workspace: {
      getLeavesOfType: () => [], getActiveViewOfType: () => null,
      on: () => ({}), onLayoutReady: () => {}
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    plugin.settings.showWords = true;
    plugin.settings.showTiming = false;
    plugin.settings.showCharacters = false;
    const tab = host.tabs[0] as { getSettingDefinitions(): import("obsidian").SettingDefinitionItem[] };
    const group = tab.getSettingDefinitions().find((item) => "heading" in item && item.heading === "Badges") as import("obsidian").SettingDefinitionGroup;
    const definition = group.items!.find((item) => "name" in item && item.name === "Show") as import("obsidian").SettingDefinition;
    const chips = new Map<string, () => Promise<void>>();
    const pressed = new Map<string, string>();
    const row = { setName: () => row, setDesc: () => row, controlEl: document.createElement("div"),
      addButton: (callback: (button: unknown) => void) => {
        let label = "";
        const buttonEl = document.createElement("button");
        const button = { buttonEl,
          setButtonText: (text: string) => { label = text; return button; },
          onClick: (run: () => Promise<void>) => { chips.set(label, run); return button; } };
        callback(button);
        pressed.set(label, buttonEl.getAttribute("aria-pressed") ?? "");
        return row;
      } };
    definition.render!(row as unknown as import("obsidian").Setting, {} as import("obsidian").SettingGroup);
    expect([...pressed]).toEqual([["Words", "true"], ["Reading time", "false"], ["Characters", "false"]]);
    const change = async (_value: boolean) => chips.get("Words")!();
    await change(false);
    expect(plugin.settings.showWords).toBe(false);
    expect(plugin.settings.showTiming).toBe(true);
    expect(host.settingsUpdates).toBe(1);
    plugin.onunload();
  });

  it("scrolls by the same amount the pinned preview grows or shrinks", async () => {
    let resized: () => void = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect() {}
    });
    type CreateOptions = { cls?: string; text?: string; attr?: Record<string, string> };
    const create = (parent: HTMLElement, tag: string, options: CreateOptions = {}) => {
      const element = document.createElement(tag);
      if (options.cls) element.className = options.cls;
      if (options.text) element.textContent = options.text;
      for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
      parent.appendChild(element);
      return element;
    };
    Object.assign(HTMLElement.prototype, {
      createDiv(this: HTMLElement, options?: CreateOptions) { return create(this, "div", options); },
      createSpan(this: HTMLElement, options?: CreateOptions) { return create(this, "span", options); },
      createEl(this: HTMLElement, tag: string, options?: CreateOptions) { return create(this, tag, options); }
    });
    const app = { vault: { on: () => ({}) }, workspace: {
      getLeavesOfType: () => [], getActiveViewOfType: () => null,
      on: () => ({}), onLayoutReady: () => {}
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    let scrollTop = 50;
    Object.defineProperty(scroller, "scrollTop", { get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    const group = document.createElement("div");
    group.className = "section-meter-settings-preview-group";
    const settingEl = document.createElement("div");
    group.append(settingEl);
    scroller.append(group);
    document.body.append(scroller);
    let height = 100;
    group.getBoundingClientRect = () => ({ height, top: 0, bottom: height } as DOMRect);

    const tab = host.tabs[0] as { getSettingDefinitions(): import("obsidian").SettingDefinitionItem[] };
    const previewGroup = tab.getSettingDefinitions()[0] as import("obsidian").SettingDefinitionGroup;
    const preview = previewGroup.items![0] as import("obsidian").SettingDefinition;
    preview.render!({ settingEl } as unknown as import("obsidian").Setting, {} as import("obsidian").SettingGroup);

    resized();
    expect(scrollTop).toBe(50);
    expect(scroller.classList.contains("section-meter-settings-scroller")).toBe(true);
    height = 130;
    resized();
    expect(scrollTop).toBe(80);
    height = 110;
    resized();
    expect(scrollTop).toBe(60);
    plugin.onunload();
  });

  it("keeps target dialog presets from submitting the form when Enter is pressed", () => {
    // Mirrors Obsidian's createEl, which applies `type` only to inputs and styles.
    Object.assign(HTMLElement.prototype, {
      createEl(this: HTMLElement, tag: string, options: { text?: string; cls?: string; type?: string;
        attr?: Record<string, string> } = {}) {
        const element = document.createElement(tag);
        if (options.cls) element.className = options.cls;
        if (options.text) element.textContent = options.text;
        for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
        if (options.type && element instanceof HTMLInputElement) element.type = options.type;
        this.appendChild(element);
        return element;
      }
    });
    const form = document.createElement("form");
    const picked: string[] = [];
    createWritingTargetPresetButtons(form, [{ metric: "words", targetValue: 250 }], () => picked.push("250"));
    const button = form.querySelector("button")!;
    expect(button.type).toBe("button");
    button.click();
    expect(picked).toEqual(["250"]);
  });

  it("uses a unit typed in the target dialog instead of the selected measure", () => {
    expect(parseWritingTargetInput("words", "30s")).toEqual({ metric: "reading-time", targetValue: 30 });
    expect(parseWritingTargetInput("reading-time", "250w")).toEqual({ metric: "words", targetValue: 250 });
    expect(parseWritingTargetInput("words", "1,800 chars")).toEqual({ metric: "characters", targetValue: 1800 });
    expect(parseWritingTargetInput("words", "250")).toEqual({ metric: "words", targetValue: 250 });
    expect(parseWritingTargetInput("reading-time", "3")).toEqual({ metric: "reading-time", targetValue: 180 });
    expect(parseWritingTargetInput("words", "30 apples")).toBeNull();
  });

  it("migrates hide empty sections to a one-word minimum", async () => {
    const app = { vault: { on: () => ({}) }, workspace: {
      getLeavesOfType: () => [], getActiveViewOfType: () => null,
      on: () => ({}), onLayoutReady: () => {}
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    plugin.loadData = async () => ({ hideEmptySections: true, minimumWordCount: 0 });
    await plugin.onload();
    expect(plugin.settings.minimumWordCount).toBe(1);
    expect(plugin.settings.hideEmptySections).toBe(false);
    plugin.onunload();
  });

  it("notifies on the first target crossing but not when opening a different completed note", () => {
    const reached = vi.fn();
    let identity = "first.md";
    const editor = createEditor("# Section\nTarget: 3 words\none two", false, {
      reached, documentIdentity: () => identity
    });
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: " three" } });
    expect(reached).toHaveBeenCalledTimes(1);
    expect(reached.mock.calls[0][1][0].label).toBe("Section");
    identity = "second.md";
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "# Other\nTarget: 1 words\nalready complete" } });
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it("removes title UI on unload and does not recreate it from a queued callback", async () => {
    const container = document.createElement("div");
    container.innerHTML = '<div><div class="inline-title">Note</div></div>';
    document.body.append(container);
    const markdownView = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      containerEl: container, getViewData: () => "hello", editor: {}
    });
    let ready: () => void = () => {};
    const app = { vault: { on: () => ({}) }, workspace: {
      getLeavesOfType: () => [{ view: markdownView }],
      getActiveViewOfType: () => null,
      on: () => ({}),
      onLayoutReady: (callback: () => void) => { ready = callback; }
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    ready();
    expect(container.querySelector(".section-meter-title-badge")).not.toBeNull();
    plugin.onunload();
    expect(container.querySelector(".section-meter-title-badge")).toBeNull();
    expect(container.querySelector(".section-meter-title-row")).toBeNull();
    ready();
    expect(container.querySelector(".section-meter-title-badge")).toBeNull();
    expect(container.querySelector(".inline-title")?.textContent).toBe("Note");
  });

  it("reserves a separate row below the editable title and before note content", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("styles.css", "utf8");
    document.body.append(style);
    const container = document.createElement("div");
    container.innerHTML = '<div class="markdown-source-view mod-cm6"><div class="cm-sizer"><div class="inline-title" contenteditable="true">Note</div><div class="metadata-container"></div><div class="cm-contentContainer">First line</div></div></div>';
    document.body.append(container);
    const markdownView = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      containerEl: container, getViewData: () => "hello", editor: {}
    });
    const app = { vault: { on: () => ({}) }, workspace: {
      getLeavesOfType: () => [{ view: markdownView }],
      getActiveViewOfType: () => null, on: () => ({}),
      onLayoutReady: (callback: () => void) => callback()
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    const title = container.querySelector<HTMLElement>(".inline-title")!;
    const badge = container.querySelector<HTMLElement>(".section-meter-title-badge")!;
    expect(title.nextElementSibling).toBe(badge);
    expect(getComputedStyle(badge).position).toBe("static");
    expect(badge.getAttribute("contenteditable")).toBe("false");
    expect(title.textContent).toBe("Note");
    expect(title.getAttribute("contenteditable")).toBe("true");
    plugin.onunload();
    expect(title.nextElementSibling?.className).toBe("metadata-container");
  });

  it("does not publish inactive editor statistics into the shared status bar", () => {
    const publish = vi.fn();
    const editor = createEditor("# Inactive\nhello", false, {
      isActive: () => false, status: publish
    });
    editor.dispatch({ selection: { anchor: 5 } });
    expect(publish).not.toHaveBeenCalled();
  });

  it("edits the displayed inherited target rather than the cursor's child section", async () => {
    const open = vi.fn();
    const editor = createEditor("# Parent\nTarget: 10 words\n## Child\nhello", true, {
      editTarget: open
    });
    editor.dispatch({ selection: { anchor: editor.state.doc.length } });
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    const meter = editor.dom.querySelector<HTMLElement>(".section-meter-mobile-current-section")!;
    expect(meter.dataset.targetPosition).toBe("0");
    meter.querySelector<HTMLElement>("[data-mobile-meter-action='edit-target']")!.click();
    expect(open).toHaveBeenCalledWith(editor, "section", 0);
  });

  it("marks the mobile meter label as reached without relying on :has()", async () => {
    const reached = createEditor("# Done\nTarget: 2 words\none two", true);
    const inProgress = createEditor("# Draft\nTarget: 10 words\none two", true);
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    const labelState = (editor: EditorView) => editor.dom
      .querySelector(".section-meter-mobile-current-section-label")!
      .classList.contains("section-meter-target-complete");
    expect(labelState(reached)).toBe(true);
    expect(labelState(inProgress)).toBe(false);
    const styles = readFileSync("styles.css", "utf8");
    expect(styles).not.toMatch(/:has\(/);
    expect(styles).not.toMatch(/(^|[\s,>+~])\*\s*[,{]/m);
  });

  it("opens the target on the first tap even when pressing the meter changes editor focus", async () => {
    const open = vi.fn();
    const editor = createEditor("# Parent\nTarget: 10 words\nhello", true, { editTarget: open });
    editor.focus();
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    const button = editor.dom.querySelector<HTMLElement>("[data-mobile-meter-action='edit-target']")!;
    // Pointer-down focuses the meter before pointer-up delivers its click.
    button.focus();
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    button.click();
    expect(open).toHaveBeenCalledWith(editor, "section", 0);
    expect(document.activeElement).toBe(button);
  });

  it("retains each editor's mobile meter when another editor opens or closes", () => {
    const first = createEditor("# One\nTarget: 10 words\nhello", true);
    const meter = first.dom.querySelector(".section-meter-mobile-current-section");
    const second = createEditor("# Two\nTarget: 20 words\nworld", true);
    expect(meter?.isConnected).toBe(true);
    expect(first.dom.querySelector(".section-meter-mobile-current-section")).toBe(meter);
    second.destroy();
    editors.splice(editors.indexOf(second), 1);
    expect(meter?.isConnected).toBe(true);
  });

  it("keeps a reused stats badge non-editable after its content changes", () => {
    const editor = createEditor("# Title\nhello");
    const badge = editor.dom.querySelector<HTMLElement>(".section-meter-badge")!;
    // Obsidian's widget host adds this on initial creation, not on DOM reuse.
    badge.setAttribute("contenteditable", "false");
    expect(badge.getAttribute("contenteditable")).toBe("false");
    // Keep the cursor in the heading while an edit changes its section count.
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: " world" } });
    const updated = editor.dom.querySelector<HTMLElement>(".section-meter-badge")!;
    expect(updated).toBe(badge);
    expect(updated.getAttribute("contenteditable")).toBe("false");
  });
});
