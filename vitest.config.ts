import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    extensions: [".ts", ".mjs", ".js", ".json"],
    alias: { obsidian: fileURLToPath(new URL("./src/test/obsidianHost.ts", import.meta.url)) }
  }
});
