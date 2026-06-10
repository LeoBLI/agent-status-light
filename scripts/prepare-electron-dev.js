#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const sourceApp = path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app");
const targetRoot = "/private/tmp/agent-status-light-electron";
const targetApp = path.join(targetRoot, "Electron.app");

if (!fs.existsSync(sourceApp)) {
  console.error(`Electron.app was not found at ${sourceApp}. Run npm install first.`);
  process.exit(1);
}

fs.mkdirSync(targetRoot, { recursive: true });

if (!isRunnableElectron(targetApp)) {
  console.log("Preparing a local signed Electron runtime in /private/tmp...");
  run("ditto", ["--norsrc", sourceApp, targetApp]);
  run("xattr", ["-cr", targetApp]);
  run("codesign", ["--force", "--deep", "--sign", "-", targetApp]);
}

function isRunnableElectron(appPath) {
  if (!fs.existsSync(appPath)) {
    return false;
  }

  try {
    childProcess.execFileSync("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=1",
      appPath
    ]);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  childProcess.execFileSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit"
  });
}
