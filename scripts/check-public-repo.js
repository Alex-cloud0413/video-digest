#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
  cwd: root,
  encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean);

for (const forbidden of [
  "bridge-config.js",
  "bridge/bridge-config.json",
  "bridge/workspace-config.json",
  "bridge/com.youtube-digest.codex-bridge.plist",
]) {
  assert.ok(!tracked.includes(forbidden), `Private local file is tracked: ${forbidden}`);
}

const credentialPatterns = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
];
const personalPathPatterns = [
  /\/Users\/[^/\s]+\/Documents\//i,
  new RegExp(["All", "Life", "Decision", "System"].join(" "), "i"),
];

for (const file of tracked) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) continue;
  if (!fs.statSync(fullPath).isFile()) continue;
  const buffer = fs.readFileSync(fullPath);
  if (buffer.includes(0)) continue;
  const source = buffer.toString("utf8");
  for (const pattern of credentialPatterns) {
    assert.doesNotMatch(source, pattern, `Credential-like value found in ${file}`);
  }
  for (const pattern of personalPathPatterns) {
    assert.doesNotMatch(source, pattern, `Personal setting found in ${file}`);
  }
}

assert.ok(tracked.includes("LICENSE"));
assert.ok(tracked.includes("NOTICE.md"));
assert.ok(tracked.includes("creator-workspace-template/README.md"));
assert.ok(tracked.includes("creator-workspace-template/learning-pack.schema.json"));

process.stdout.write(
  `Public repository check passed for ${tracked.length} publishable files.\n`,
);
