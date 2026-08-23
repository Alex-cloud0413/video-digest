#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const extensionConfigPath = path.join(root, "bridge-config.js");
const serverConfigPath = path.join(root, "bridge", "bridge-config.json");
const workspaceConfigPath = path.join(root, "bridge", "workspace-config.json");

for (const file of [
  "manifest.json",
  "background.js",
  "learning-pack.js",
  "question-answer.js",
  "settings.js",
  "bridge-config.js",
  "sidepanel.html",
  "options.html",
  "bridge/server.js",
  "bridge/learning-pack-writer.js",
  "bridge/bridge-config.json",
  "bridge/workspace-config.json",
]) {
  assert.ok(fs.statSync(path.join(root, file)).isFile(), `Missing ${file}`);
}

for (const file of [
  "background.js",
  "learning-pack.js",
  "question-answer.js",
  "settings.js",
  "sidepanel.js",
  "options.js",
  "bridge/server.js",
  "bridge/learning-pack-writer.js",
  "bridge/generate-config.js",
]) {
  execFileSync(process.execPath, ["--check", path.join(root, file)], {
    stdio: "inherit",
  });
}

const serverConfig = JSON.parse(fs.readFileSync(serverConfigPath, "utf8"));
const workspaceConfig = JSON.parse(fs.readFileSync(workspaceConfigPath, "utf8"));
const sandbox = { globalThis: {} };
vm.runInNewContext(fs.readFileSync(extensionConfigPath, "utf8"), sandbox, {
  filename: "bridge-config.js",
});
const extensionConfig = sandbox.globalThis.YTD_LOCAL_BRIDGE;

assert.equal(serverConfig.host, "127.0.0.1");
assert.equal(serverConfig.port, 43110);
assert.match(serverConfig.token, /^[a-f0-9]{64}$/);
assert.equal(extensionConfig.baseUrl, "http://127.0.0.1:43110");
assert.equal(extensionConfig.token, serverConfig.token);
assert.equal(typeof workspaceConfig.workspaceRoot, "string");
assert.ok(path.isAbsolute(workspaceConfig.workspaceRoot));
assert.equal(fs.statSync(serverConfigPath).mode & 0o777, 0o600);
assert.equal(fs.statSync(extensionConfigPath).mode & 0o777, 0o600);
assert.equal(fs.statSync(workspaceConfigPath).mode & 0o777, 0o600);

if (fs.existsSync(path.join(root, ".git"))) {
  for (const file of [
    "bridge-config.js",
    "bridge/bridge-config.json",
    "bridge/workspace-config.json",
  ]) {
    const ignored = execFileSync("git", ["check-ignore", file], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    assert.equal(ignored, file);
  }
} else {
  const ignoreRules = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(ignoreRules, /^bridge-config\.js$/m);
  assert.match(ignoreRules, /^bridge\/bridge-config\.json$/m);
  assert.match(ignoreRules, /^bridge\/workspace-config\.json$/m);
}

process.stdout.write(
  "Local install check passed. Generated capability was not printed or packaged.\n",
);
