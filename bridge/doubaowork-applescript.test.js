const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DoubaoWorkAppleEventsController,
  friendlyAutomationError,
} = require("./doubaowork-applescript.js");

test("Doubao Work status requires both the desktop app and Apple Events JavaScript", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-digest-status-"));
  const appPath = path.join(root, "DoubaoWork Browser.app");
  const preferencesPath = path.join(root, "Preferences");
  try {
    fs.mkdirSync(appPath);
    fs.writeFileSync(
      preferencesPath,
      JSON.stringify({ browser: { allow_javascript_apple_events: true } }),
    );
    const controller = new DoubaoWorkAppleEventsController({
      appPath,
      preferencesPath,
    });
    assert.deepEqual(controller.getStatus(), {
      available: true,
      mode: "inline",
      installed: true,
      automation: true,
      client: "Doubao Work desktop",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Doubao Work keeps injected JavaScript out of process arguments", async () => {
  const secret = "private transcript text";
  let inspected = false;
  const controller = new DoubaoWorkAppleEventsController({
    runCommand: async (file, args) => {
      assert.equal(file, "/usr/bin/osascript");
      assert.equal(args.some((value) => String(value).includes(secret)), false);
      const javascriptPath = args.at(-1);
      assert.equal(fs.statSync(javascriptPath).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(javascriptPath, "utf8"), secret);
      inspected = true;
      return { stdout: "done\n", stderr: "" };
    },
  });
  assert.equal(await controller.executeJavaScript(42, secret), "done");
  assert.equal(inspected, true);
});

test("Doubao Work request waits for the final non-streaming assistant reply", async () => {
  let responsePolls = 0;
  class FakeController extends DoubaoWorkAppleEventsController {
    getStatus() {
      return { installed: true, automation: true, available: true };
    }

    async ensureWindow() {
      return 42;
    }

    async runAppleScript() {
      return { stdout: "", stderr: "" };
    }

    async executeJavaScript(windowId, javascript) {
      assert.equal(windowId, 42);
      if (javascript.includes("message_text_content")) {
        responsePolls += 1;
        return responsePolls === 1
          ? JSON.stringify({ text: "partial", streaming: true })
          : JSON.stringify({ text: "Final Doubao Work result", streaming: false });
      }
      if (javascript.includes("send.click")) return JSON.stringify({ sent: true });
      if (javascript.includes("prompt could not be inserted")) {
        return JSON.stringify({ ok: true });
      }
      return JSON.stringify({ ready: true });
    }
  }

  const controller = new FakeController({ sleep: async () => {}, timeoutMs: 1_000 });
  assert.equal(
    await controller.requestCompletion("Summarize this transcript"),
    "Final Doubao Work result",
  );
  assert.equal(responsePolls, 2);
});

test("Doubao Work maps disabled Apple Events automation to setup guidance", () => {
  const mapped = friendlyAutomationError(
    Object.assign(new Error("Not authorized to send Apple events"), { code: -1743 }),
  );
  assert.match(mapped.message, /Allow JavaScript from Apple Events/);
});
