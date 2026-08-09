const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

test("DeepSeek defaults use V4 Flash", () => {
  const normalized = settings.normalize({
    provider: "deepseek",
    aiApiKey: "  example-key  ",
    supadataApiKey: "  example-supadata  ",
  });

  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.aiModel, "deepseek-v4-flash");
  assert.equal(normalized.aiApiKey, "example-key");
  assert.equal(normalized.supadataApiKey, "example-supadata");
});

test("custom OpenAI-compatible settings are preserved", () => {
  const normalized = settings.normalize({
    provider: "custom",
    aiBaseUrl: " https://api.example.com/v1/ ",
    aiModel: " example-model ",
  });

  assert.equal(normalized.provider, "custom");
  assert.equal(normalized.aiBaseUrl, "https://api.example.com/v1/");
  assert.equal(normalized.aiModel, "example-model");
  assert.equal(
    settings.chatCompletionsUrl(normalized.aiBaseUrl),
    "https://api.example.com/v1/chat/completions",
  );
  assert.equal(
    settings.permissionPattern(normalized.aiBaseUrl),
    "https://api.example.com/*",
  );
});

test("remote custom providers must use HTTPS", () => {
  assert.throws(
    () => settings.chatCompletionsUrl("http://api.example.com/v1"),
    /Use HTTPS/,
  );
  assert.equal(
    settings.chatCompletionsUrl("http://localhost:11434/v1"),
    "http://localhost:11434/v1/chat/completions",
  );
  assert.throws(
    () => settings.chatCompletionsUrl("https://user:pass@api.example.com/v1"),
    /cannot contain credentials/,
  );
});

test("Supadata receives a canonical YouTube URL", () => {
  assert.equal(
    settings.canonicalYouTubeUrl("ydTeb_I0b94"),
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
  assert.throws(
    () => settings.canonicalYouTubeUrl('"><script>'),
    /Invalid YouTube video ID/,
  );
});

test("translated overviews are rebuilt from the original validated schema", () => {
  const source = {
    chapters: [
      {
        title: "Original title",
        summary: "Original summary",
        timestamp: "1:30",
        timestampSeconds: 90,
      },
    ],
    keyQuotes: [
      {
        quote: "Original quote",
        timestamp: "2:00",
        timestampSeconds: 120,
      },
    ],
  };
  const translated = settings.normalizeTranslatedOverview(
    {
      chapters: [
        {
          title: "Translated title",
          summary: "Translated summary",
          timestamp: "999:99",
          timestampSeconds: 99999,
        },
      ],
      keyQuotes: [
        {
          quote: "Translated quote",
          timestamp: "999:99",
          timestampSeconds: 99999,
        },
      ],
    },
    source,
  );

  assert.deepEqual(translated, {
    chapters: [
      {
        title: "Translated title",
        summary: "Translated summary",
        timestamp: "1:30",
        timestampSeconds: 90,
      },
    ],
    keyQuotes: [
      {
        quote: "Translated quote",
        timestamp: "2:00",
        timestampSeconds: 120,
      },
    ],
  });
  assert.equal(
    settings.normalizeTranslatedOverview(
      { chapters: {}, keyQuotes: [] },
      source,
    ),
    null,
  );
});
