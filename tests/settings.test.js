const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

test("local Codex settings are fixed and contain no provider key", () => {
  const normalized = settings.normalize({
    provider: "unexpected",
    aiApiKey: "must-not-survive",
  });

  assert.deepEqual(normalized, {
    provider: "codex-local",
    aiBaseUrl: "http://127.0.0.1:43110",
    aiModel: "chatgpt-subscription",
  });
  assert.equal(Object.hasOwn(normalized, "aiApiKey"), false);
  assert.equal(
    settings.bridgeCompletionUrl(),
    "http://127.0.0.1:43110/v1/complete",
  );
  assert.equal(settings.bridgeHealthUrl(), "http://127.0.0.1:43110/health");
});

test("canonical YouTube URLs reject unsafe video IDs", () => {
  assert.equal(
    settings.canonicalYouTubeUrl("ydTeb_I0b94"),
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
  assert.throws(
    () => settings.canonicalYouTubeUrl('\"><script>'),
    /Invalid YouTube video ID/,
  );
});
