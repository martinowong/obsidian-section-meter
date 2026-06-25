import { spawnSync } from "node:child_process";
import process from "node:process";

const buildLabel = process.env.SECTION_METER_BUILD_LABEL ?? createLocalBuildLabel();
const env = {
  ...process.env,
  SECTION_METER_BUILD_LABEL: buildLabel
};

run("TypeScript check", getLocalBinary("tsc"), ["--noEmit", "--skipLibCheck"]);
run("Production bundle", process.execPath, ["esbuild.config.mjs", "production"]);

console.log(`Built Section Meter with build label: ${buildLabel}`);

function createLocalBuildLabel() {
  const now = new Date();
  const timezoneOffsetMinutes = -now.getTimezoneOffset();
  const timezoneSign = timezoneOffsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(timezoneOffsetMinutes);
  const timezoneHours = Math.floor(absoluteOffsetMinutes / 60)
    .toString()
    .padStart(2, "0");
  const timezoneMinutes = (absoluteOffsetMinutes % 60).toString().padStart(2, "0");
  const timestamp = [
    now.getFullYear(),
    (now.getMonth() + 1).toString().padStart(2, "0"),
    now.getDate().toString().padStart(2, "0")
  ].join("-")
    + " "
    + [
      now.getHours().toString().padStart(2, "0"),
      now.getMinutes().toString().padStart(2, "0"),
      now.getSeconds().toString().padStart(2, "0")
    ].join(":")
    + ` GMT${timezoneSign}${timezoneHours}:${timezoneMinutes}`;

  return `local ${timestamp}`;
}

function getLocalBinary(name) {
  return process.platform === "win32"
    ? `node_modules\\.bin\\${name}.cmd`
    : `node_modules/.bin/${name}`;
}

function run(label, command, args) {
  const result = spawnSync(command, args, {
    env,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}
