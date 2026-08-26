const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadHelpers({ fetchImpl = fetch, executeScript, pageGlobals } = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    importScripts() {},
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: () => ({ provider: "codex-local", aiModel: "subscription" }),
      canonicalYouTubeUrl: (videoId) => `https://www.youtube.com/watch?v=${videoId}`,
    },
    YTD_LOCAL_BRIDGE: {
      baseUrl: "http://127.0.0.1:43110",
      token: "test-token",
    },
    chrome: {
      storage: { local: { setAccessLevel: () => Promise.resolve() } },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resource) => `chrome-extension://test/${resource}`,
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
      scripting: {
        executeScript:
          executeScript ||
          (async ({ func, args = [] }) => [{ result: await func(...args) }]),
      },
    },
  };
  Object.assign(sandbox, pageGlobals || {});
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), sandbox);
  return sandbox.__YTD_DIRECT_TRANSCRIPT_TESTING__;
}

test("caption selection prefers English and human-created tracks", () => {
  const helpers = loadHelpers();
  const selected = helpers.selectCaptionTrack([
    { baseUrl: "https://www.youtube.com/fr", languageCode: "fr", kind: "" },
    { baseUrl: "https://www.youtube.com/en-auto", languageCode: "en", kind: "asr" },
    { baseUrl: "https://www.youtube.com/en", languageCode: "en", kind: "" },
  ]);
  assert.equal(selected.baseUrl, "https://www.youtube.com/en");
});

test("YouTube JSON3 captions become seekable transcript rows", () => {
  const helpers = loadHelpers();
  const transcript = helpers.parseYouTubeCaptionPayload(
    JSON.stringify({
      events: [
        { tStartMs: 1250, dDurationMs: 2400, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
        { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: ">> Next line" }] },
      ],
    }),
    "en",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(transcript)),
    [
      { text: "Hello world", start: 1.25, duration: 2.4, language: "en" },
      { text: "Next line", start: 4, duration: 1, language: "en" },
    ],
  );
  const result = helpers.buildTranscriptResult(transcript, "en");
  assert.equal(result.transcriptTextTimestamped, "[0:01] Hello world\n[0:04] Next line");
});

test("legacy XML captions are decoded without a DOM parser", () => {
  const helpers = loadHelpers();
  const transcript = helpers.parseYouTubeCaptionPayload(
    '<transcript><text start="1.5" dur="2">Tom &amp; Jerry</text></transcript>',
    "en",
  );
  assert.equal(transcript[0].text, "Tom & Jerry");
  assert.equal(transcript[0].start, 1.5);
});

test("Bilibili subtitle JSON becomes seekable transcript rows", () => {
  const helpers = loadHelpers();
  const transcript = helpers.parseBilibiliSubtitle(
    {
      body: [
        { from: 1.2, to: 3.8, content: "第一条字幕" },
        { from: 4, to: 5.5, content: "Second line" },
      ],
    },
    "zh-CN",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(transcript)), [
    { text: "第一条字幕", start: 1.2, duration: 2.5999999999999996, language: "zh-CN" },
    { text: "Second line", start: 4, duration: 1.5, language: "zh-CN" },
  ]);
});

test("Bilibili subtitle discovery runs in the signed-in page context", async () => {
  const calls = [];
  const helpers = loadHelpers({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      throw new Error("subtitle files must not be fetched in the page context");
    },
    pageGlobals: {
      location: {
        pathname: "/video/BV1zu4y1y7Sh/",
      },
      __INITIAL_STATE__: {
        videoData: {
          bvid: "BV1zu4y1y7Sh",
          cid: 1259322977,
          title: "Subtitle test",
          owner: { name: "Test uploader" },
          duration: 124,
        },
      },
      __playinfo__: {
        data: {
          subtitle: {
            subtitles: [
              {
                lan: "zh-CN",
                lan_doc: "中文（AI生成）",
                subtitle_url: "//i0.hdslb.com/bfs/subtitle/test.json",
              },
            ],
          },
        },
      },
    },
  });

  const result = await helpers.getBilibiliSubtitleTrackFromPage(
    7,
    "BV1zu4y1y7Sh",
    1,
  );
  assert.equal(result.ok, true);
  assert.equal(result.language, "zh-CN");
  assert.match(result.subtitleUrl, /^https:\/\/i0\.hdslb\.com\/bfs\/subtitle\//);
  assert.equal(calls.length, 0);
});

test("Bilibili subtitle payload downloads in the extension worker", async () => {
  const calls = [];
  const helpers = loadHelpers({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            body: [{ from: 2, to: 4.5, content: "Worker-fetched captions" }],
          }),
      };
    },
  });

  const payload = await helpers.fetchBilibiliSubtitlePayload(
    "https://i0.hdslb.com/bfs/subtitle/test.json",
  );
  assert.equal(payload.body[0].content, "Worker-fetched captions");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, "omit");
});

test("Bilibili subtitle worker rejects non-subtitle CDN paths", async () => {
  let fetchCount = 0;
  const helpers = loadHelpers({
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("must not fetch");
    },
  });

  await assert.rejects(
    helpers.fetchBilibiliSubtitlePayload(
      "https://i0.hdslb.com/bfs/archive/video-file.m4s",
    ),
    /unsupported subtitle URL/,
  );
  assert.equal(fetchCount, 0);
});

test("subtitle payload fetch runs in the page context and retries JSON3", async () => {
  const calls = [];
  const helpers = loadHelpers({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () =>
          calls.length === 1
            ? ""
            : JSON.stringify({
                events: [
                  { tStartMs: 0, segs: [{ utf8: "Page-context captions" }] },
                ],
              }),
      };
    },
  });

  const result = await helpers.fetchCaptionPayloadInPage(
    7,
    "https://www.youtube.com/api/timedtext?v=test-video",
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("fmt"), "json3");
  assert.equal(calls[0].options.credentials, "include");
  assert.match(result.payload, /Page-context captions/);
});

test("page-context subtitle fetch rejects non-YouTube hosts", async () => {
  let fetchCount = 0;
  const helpers = loadHelpers({
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("must not fetch");
    },
  });
  const result = await helpers.fetchCaptionPayloadInPage(
    7,
    "https://example.com/captions",
  );
  assert.equal(result.ok, false);
  assert.equal(fetchCount, 0);
});
