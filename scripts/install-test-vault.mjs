import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const vaultPath = process.env.SECTION_METER_TEST_VAULT;

if (!vaultPath) {
  throw new Error(
    "Set SECTION_METER_TEST_VAULT to the absolute path of an Obsidian test vault."
  );
}

const projectRoot = resolve(import.meta.dirname, "..");
const pluginDirectory = resolve(vaultPath, ".obsidian/plugins/section-meter");
const fixtureSource = resolve(projectRoot, "test-vault/Section Writing Stats test cases.md");
const fixtureDestination = resolve(vaultPath, "Section Writing Stats test cases.md");

mkdirSync(pluginDirectory, { recursive: true });

for (const filename of ["main.js", "manifest.json", "styles.css"]) {
  copyFileSync(resolve(projectRoot, filename), resolve(pluginDirectory, filename));
}

mkdirSync(dirname(fixtureDestination), { recursive: true });
copyFileSync(fixtureSource, fixtureDestination);

console.log(`Installed Section Writing Stats in ${pluginDirectory}`);
console.log(`Refreshed manual test note: ${fixtureDestination}`);
