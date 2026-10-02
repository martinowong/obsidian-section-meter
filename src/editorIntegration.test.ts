// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App, PluginManifest } from "obsidian";
import type { TargetCompletion } from "./targetCompletion";
import { readFileSync } from "node:fs";

const host = vi.hoisted(() => ({ extensions: [] as unknown[], tabs: [] as unknown[], settingsUpdates: 0 }));

// Obsidian is the external host. CodeMirror and the plugin run unmocked.
vi.mock("obsidian", () => ({
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
    registerEvent() {}
    addSettingTab(tab: unknown) { host.tabs.push(tab); }
    addCommand() {}
  },
  PluginSettingTab: class {
    update() { host.settingsUpdates++; }
  },
  Modal: class {},
  MarkdownView: class {},
  Notice: class {},
  Setting: class {},
  TextComponent: class {}
}));
import SectionMeterPlugin, { createSectionMeterExtension } from "../main";
import { MarkdownView } from "obsidian";

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
  it("keeps editor UI in place when saving a preview-only preference", async () => {
    let active: MarkdownView | null = null;
    const app = { workspace: {
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
    const app = { workspace: {
      getLeavesOfType: () => [], getActiveViewOfType: () => null,
      on: () => ({}), onLayoutReady: () => {}
    }} as unknown as App;
    const plugin = new SectionMeterPlugin(app, {} as PluginManifest);
    await plugin.onload();
    plugin.settings.showWords = true;
    plugin.settings.showTiming = false;
    plugin.settings.showCharacters = false;
    const tab = host.tabs[0] as { getSettingDefinitions(): import("obsidian").SettingDefinitionItem[] };
    const group = tab.getSettingDefinitions().find((item) => "heading" in item && item.heading === "Badge display") as import("obsidian").SettingDefinitionGroup;
    const definition = group.items!.find((item) => "name" in item && item.name === "Word count") as import("obsidian").SettingDefinition;
    let change: (value: boolean) => Promise<void> = async () => {};
    const toggle = { setValue: () => toggle, setDisabled: () => toggle,
      onChange: (callback: typeof change) => { change = callback; return toggle; } };
    const row = { setName: () => row, setDesc: () => row,
      addToggle: (callback: (control: typeof toggle) => void) => { callback(toggle); return row; } };
    definition.render!(row as unknown as import("obsidian").Setting, {} as import("obsidian").SettingGroup);
    await change(false);
    expect(plugin.settings.showWords).toBe(false);
    expect(plugin.settings.showTiming).toBe(true);
    expect(host.settingsUpdates).toBe(1);
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
    const app = { workspace: {
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
    const app = { workspace: {
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
