const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const i18n = require("../sidepanel-i18n.js");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("side panel supports English, Simplified Chinese, and German", () => {
  assert.deepEqual(i18n.SUPPORTED_LANGUAGES, ["en", "zh-CN", "de"]);
  assert.equal(i18n.translate("en", "tabTranscript"), "Transcript");
  assert.equal(i18n.translate("zh-CN", "tabTranscript"), "字幕");
  assert.equal(i18n.translate("de", "tabTranscript"), "Transkript");
  assert.equal(i18n.normalizeLanguage("unsupported"), "en");
  assert.deepEqual(
    Object.keys(i18n.COPY.en).sort(),
    Object.keys(i18n.COPY["zh-CN"]).sort(),
  );
  assert.deepEqual(
    Object.keys(i18n.COPY.en).sort(),
    Object.keys(i18n.COPY.de).sort(),
  );
});

test("every localized side-panel key exists in all languages", () => {
  const html = read("sidepanel.html");
  const referencedKeys = [
    ...html.matchAll(
      /data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"/g,
    ),
  ].map((match) => match[1]);

  for (const key of referencedKeys) {
    assert.ok(i18n.COPY.en[key], `Missing English copy for ${key}`);
    assert.ok(i18n.COPY["zh-CN"][key], `Missing Chinese copy for ${key}`);
    assert.ok(i18n.COPY.de[key], `Missing German copy for ${key}`);
  }
});

test("language control persists one shared local preference", () => {
  const html = read("sidepanel.html");
  const panelJs = read("sidepanel.js");
  const optionsJs = read("options.js");
  assert.match(html, /id="languageBtn"/);
  assert.ok(
    html.indexOf('src="sidepanel-i18n.js"') < html.indexOf('src="sidepanel.js"'),
  );
  assert.match(panelJs, /stored\[i18n\.STORAGE_KEY\] \|\| "en"/);
  assert.match(optionsJs, /stored\[LANGUAGE_STORAGE_KEY\] \|\| "en"/);
  assert.equal(i18n.STORAGE_KEY, "ytd_options_language");
});
