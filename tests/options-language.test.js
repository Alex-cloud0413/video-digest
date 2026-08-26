const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const options = require("../options.js");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("settings copy covers English and Simplified Chinese", () => {
  assert.equal(
    options.translate("en", "pageTitle"),
    "YouTube Digest + Codex",
  );
  assert.equal(
    options.translate("zh-CN", "pageTitle"),
    "YouTube Digest + Codex",
  );
  assert.equal(
    options.translate("zh-CN", "clearedDigests", { count: 2 }),
    "已清除 2 个视频缓存。",
  );
  assert.equal(options.normalizeLanguage("unsupported"), "en");
  assert.deepEqual(
    Object.keys(options.COPY.en).sort(),
    Object.keys(options.COPY["zh-CN"]).sort(),
  );
});

test("every localized options-page key exists", () => {
  const html = read("options.html");
  const referencedKeys = [
    ...html.matchAll(/data-i18n(?:-html|-aria-label)?="([^"]+)"/g),
  ].map((match) => match[1]);

  for (const key of referencedKeys) {
    assert.ok(options.COPY.en[key], `Missing English copy for ${key}`);
    assert.ok(options.COPY["zh-CN"][key], `Missing Chinese copy for ${key}`);
  }
});

test("options page exposes local status and no API-key fields", () => {
  const html = read("options.html");
  assert.match(html, /id="checkConnectionBtn"/);
  assert.match(html, /YouTube \+ Bilibili subtitles/);
  assert.match(html, /ChatGPT sign-in/);
  assert.doesNotMatch(html, /type="password"/i);
  assert.doesNotMatch(html, /id="(?:supadataApiKey|aiApiKey)"/i);
});
