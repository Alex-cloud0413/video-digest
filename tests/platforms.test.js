const test = require("node:test");
const assert = require("node:assert/strict");

const platforms = require("../platforms.js");

test("video URLs are detected and canonicalized per platform", () => {
  assert.deepEqual(
    platforms.detectVideoSource("https://www.youtube.com/watch?v=aircAruvnKk&t=2"),
    {
      platform: "youtube",
      videoId: "aircAruvnKk",
      pageNumber: 1,
      contentKey: "youtube:aircAruvnKk",
    },
  );
  assert.deepEqual(
    platforms.detectVideoSource("https://www.bilibili.com/video/BV1zu4y1y7Sh/?p=2"),
    {
      platform: "bilibili",
      videoId: "BV1zu4y1y7Sh",
      pageNumber: 2,
      contentKey: "bilibili:BV1zu4y1y7Sh:p2",
    },
  );
  assert.equal(
    platforms.timestampedVideoUrl("bilibili", "BV1zu4y1y7Sh", 49, 2),
    "https://www.bilibili.com/video/BV1zu4y1y7Sh/?p=2&t=49",
  );
  assert.equal(platforms.detectVideoSource("https://www.bilibili.com/"), null);
});
