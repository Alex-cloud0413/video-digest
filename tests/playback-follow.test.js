const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const playbackFollow = require(path.join(root, "playback-follow.js"));
const sidepanelSource = fs.readFileSync(
  path.join(root, "sidepanel.js"),
  "utf8",
);
const sidepanelHtml = fs.readFileSync(
  path.join(root, "sidepanel.html"),
  "utf8",
);
const backgroundSource = fs.readFileSync(
  path.join(root, "background.js"),
  "utf8",
);

test("active transcript lookup follows ordered playback boundaries", () => {
  const starts = [0, 12.5, 28, 60];

  assert.equal(playbackFollow.findActiveEntryIndex(starts, -0.1), -1);
  assert.equal(playbackFollow.findActiveEntryIndex(starts, 0), 0);
  assert.equal(playbackFollow.findActiveEntryIndex(starts, 12.49), 0);
  assert.equal(playbackFollow.findActiveEntryIndex(starts, 12.5), 1);
  assert.equal(playbackFollow.findActiveEntryIndex(starts, 3600), 3);
  assert.equal(playbackFollow.findActiveEntryIndex(starts, NaN), -1);
});

test("follow-zone detection keeps the active row in the central viewport", () => {
  const viewport = { containerTop: 100, containerHeight: 500 };

  assert.equal(
    playbackFollow.isEntryInFollowZone({
      ...viewport,
      entryTop: 260,
      entryBottom: 320,
    }),
    true,
  );
  assert.equal(
    playbackFollow.isEntryInFollowZone({
      ...viewport,
      entryTop: 120,
      entryBottom: 180,
    }),
    false,
  );
  assert.equal(
    playbackFollow.isEntryInFollowZone({
      ...viewport,
      entryTop: 560,
      entryBottom: 620,
    }),
    false,
  );
});

test("centered scroll targets are container-local and clamped", () => {
  assert.equal(
    playbackFollow.getCenteredScrollTop({
      scrollTop: 400,
      containerTop: 100,
      containerHeight: 600,
      entryTop: 700,
      entryHeight: 80,
      scrollHeight: 2400,
    }),
    740,
  );

  assert.equal(
    playbackFollow.getCenteredScrollTop({
      scrollTop: 0,
      containerTop: 100,
      containerHeight: 600,
      entryTop: 110,
      entryHeight: 40,
      scrollHeight: 2400,
    }),
    0,
  );

  assert.equal(
    playbackFollow.getCenteredScrollTop({
      scrollTop: 1700,
      containerTop: 100,
      containerHeight: 600,
      entryTop: 900,
      entryHeight: 80,
      scrollHeight: 2400,
    }),
    1800,
  );
});

test("side panel distinguishes user scroll intent from its own smooth scroll", () => {
  assert.match(
    sidepanelHtml,
    /<script src="playback-follow\.js"><\/script>\s*<script src="sidepanel\.js"><\/script>/,
  );
  assert.match(sidepanelSource, /playbackTrackingTick\(\);/);
  assert.match(sidepanelSource, /playbackTrackingRequestInFlight/);
  assert.match(sidepanelSource, /action: "getPlaybackState"/);
  assert.match(
    sidepanelSource,
    /state !== "results"[\s\S]*?\.tab\.active[\s\S]*?startPlaybackTracking\(\)/,
  );
  assert.match(sidepanelSource, /contentArea\.scrollTo\(\{/);
  assert.match(sidepanelSource, /addEventListener\("wheel", onPlaybackFollowUserIntent/);
  assert.match(sidepanelSource, /addEventListener\("touchmove", onPlaybackFollowUserIntent/);
  assert.doesNotMatch(sidepanelSource, /addEventListener\("scroll", onContentAreaScroll/);
  assert.match(
    backgroundSource,
    /async function getVideoPlaybackStateInTab\(tabId\)[\s\S]*?chrome\.scripting\.executeScript\(\{[\s\S]*?world: "MAIN"/,
  );
});
