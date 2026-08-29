const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const DEFAULT_APP_PATH =
  "/Applications/DoubaoWork.app/Contents/Helpers/DoubaoWork Browser.app";
const DEFAULT_PREFERENCES_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "DoubaoWork",
  "Default",
  "Preferences",
);
const WINDOW_NAME = "video-digest-bridge";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const EXECUTE_JAVASCRIPT_SCRIPT = [
  "on run argv",
  "set targetWindowId to item 1 of argv as integer",
  "set jsPath to item 2 of argv",
  "set jsCode to read POSIX file jsPath as «class utf8»",
  'tell application id "com.work.pc.doubao.browser"',
  "return execute active tab of window id targetWindowId javascript jsCode",
  "end tell",
  "end run",
];

const ENSURE_WINDOW_SCRIPT = [
  "on run argv",
  "set targetUrl to item 1 of argv",
  'tell application id "com.work.pc.doubao.browser"',
  "launch",
  "repeat with candidateWindow in windows",
  "try",
  'set marker to execute active tab of candidateWindow javascript "window.name"',
  `if marker is "${WINDOW_NAME}" then return id of candidateWindow`,
  "end try",
  "end repeat",
  'set bridgeWindow to make new window with properties {mode:"normal"}',
  "set URL of active tab of bridgeWindow to targetUrl",
  "set minimized of bridgeWindow to true",
  "return id of bridgeWindow",
  "end tell",
  "end run",
];

const NAVIGATE_WINDOW_SCRIPT = [
  "on run argv",
  "set targetWindowId to item 1 of argv as integer",
  "set targetUrl to item 2 of argv",
  'tell application id "com.work.pc.doubao.browser"',
  "set URL of active tab of window id targetWindowId to targetUrl",
  "set minimized of window id targetWindowId to false",
  "end tell",
  "end run",
];

const MINIMIZE_WINDOW_SCRIPT = [
  "on run argv",
  "set targetWindowId to item 1 of argv as integer",
  'tell application id "com.work.pc.doubao.browser"',
  "set minimized of window id targetWindowId to true",
  "end tell",
  "end run",
];

function appleScriptArgs(lines, argv = []) {
  return lines.flatMap((line) => ["-e", line]).concat(argv.map(String));
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function parseJsonResult(value, fallbackError) {
  try {
    return JSON.parse(String(value || "").trim());
  } catch {
    throw new Error(fallbackError);
  }
}

function friendlyAutomationError(error) {
  const detail = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join("\n");
  if (
    /AppleScript.*JavaScript|Apple Events.*JavaScript|Apple 事件.*JavaScript|1743|not authorized/i.test(
      detail,
    )
  ) {
    return new Error(
      "Doubao Work automation is disabled. In Doubao Work, enable View > Developer > Allow JavaScript from Apple Events, then try again.",
    );
  }
  if (/Application isn.t running|application.*not found|找不到应用程序/i.test(detail)) {
    return new Error("Doubao Work desktop could not be opened");
  }
  return new Error(`Doubao Work automation failed: ${detail.trim() || "unknown error"}`);
}

class DoubaoWorkAppleEventsController {
  constructor(options = {}) {
    this.appPath = options.appPath || DEFAULT_APP_PATH;
    this.preferencesPath = options.preferencesPath || DEFAULT_PREFERENCES_PATH;
    this.runCommand = options.runCommand || execFileAsync;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs || 180_000;
    this.pollIntervalMs = options.pollIntervalMs || 750;
    this.windowId = null;
  }

  getStatus() {
    let automation = false;
    try {
      const preferences = JSON.parse(fs.readFileSync(this.preferencesPath, "utf8"));
      automation = preferences?.browser?.allow_javascript_apple_events === true;
    } catch {
      automation = false;
    }
    const installed = fs.existsSync(this.appPath);
    return {
      available: installed && automation,
      mode: "inline",
      installed,
      automation,
      client: installed ? "Doubao Work desktop" : "",
    };
  }

  async runAppleScript(lines, argv = []) {
    try {
      return await this.runCommand(
        "/usr/bin/osascript",
        appleScriptArgs(lines, argv),
        { encoding: "utf8", timeout: this.timeoutMs, maxBuffer: MAX_RESPONSE_BYTES + 65_536 },
      );
    } catch (error) {
      throw friendlyAutomationError(error);
    }
  }

  async executeJavaScript(windowId, javascript) {
    const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "video-digest-doubao-"),
      { encoding: "utf8" },
    );
    const javascriptPath = path.join(tempDirectory, "request.js");
    try {
      fs.chmodSync(tempDirectory, 0o700);
      fs.writeFileSync(javascriptPath, javascript, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(javascriptPath, 0o600);
      const result = await this.runAppleScript(EXECUTE_JAVASCRIPT_SCRIPT, [
        windowId,
        javascriptPath,
      ]);
      return result.stdout.trim();
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  }

  async ensureWindow() {
    if (this.windowId) {
      try {
        const marker = await this.executeJavaScript(this.windowId, "window.name");
        if (marker === WINDOW_NAME) return this.windowId;
      } catch {
        this.windowId = null;
      }
    }

    const chatUrl = "doubaowork://doubaowork-chat/chat?video_digest_bridge=1";
    try {
      await this.runCommand("/usr/bin/open", ["-g", "-a", this.appPath, chatUrl], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 65_536,
      });
      await this.sleep(600);
    } catch (error) {
      throw friendlyAutomationError(error);
    }
    const result = await this.runAppleScript(ENSURE_WINDOW_SCRIPT, [chatUrl]);
    const windowId = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isInteger(windowId)) {
      throw new Error("Doubao Work did not provide an automation window");
    }
    this.windowId = windowId;
    return windowId;
  }

  async waitForInput(windowId, deadline) {
    while (Date.now() < deadline) {
      const state = parseJsonResult(
        await this.executeJavaScript(
          windowId,
          `JSON.stringify((() => {
            window.name = ${JSON.stringify(WINDOW_NAME)};
            const input = document.querySelector('[data-testid="chat_input_input"] [role="textbox"], [role="textbox"]');
            return { ready: Boolean(input) };
          })())`,
        ),
        "Doubao Work returned an invalid page state",
      );
      if (state.ready) return;
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error("Doubao Work request timed out while opening a new chat");
  }

  async submitPrompt(windowId, prompt, deadline) {
    const encodedPrompt = Buffer.from(prompt, "utf8").toString("base64");
    let inserted = false;
    while (Date.now() < deadline && !inserted) {
      const result = parseJsonResult(
        await this.executeJavaScript(
          windowId,
          `JSON.stringify((() => {
            const input = document.querySelector('[data-testid="chat_input_input"] [role="textbox"], [role="textbox"]');
            if (!input) return { ok: false, retry: true };
            const bytes = Uint8Array.from(atob(${JSON.stringify(encodedPrompt)}), character => character.charCodeAt(0));
            const prompt = new TextDecoder().decode(bytes);
            window.focus();
            input.focus();
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, prompt);
            if (!(input.innerText || input.textContent || "").trim()) {
              return { ok: false, error: "prompt could not be inserted" };
            }
            return { ok: true };
          })())`,
        ),
        "Doubao Work returned an invalid submission state",
      );
      if (result.ok) {
        inserted = true;
        break;
      }
      if (!result.retry) {
        throw new Error(`Doubao Work ${result.error || "did not accept the prompt"}`);
      }
      await this.sleep(this.pollIntervalMs);
    }
    if (!inserted) {
      throw new Error("Doubao Work request timed out while waiting for the chat input");
    }

    while (Date.now() < deadline) {
      const sendState = parseJsonResult(
        await this.executeJavaScript(
          windowId,
          `JSON.stringify((() => {
            const send = document.querySelector('[data-testid="chat_input_send_button"]');
            if (!send) return { sent: false };
            send.click();
            return { sent: true };
          })())`,
        ),
        "Doubao Work returned an invalid send-button state",
      );
      if (sendState.sent) return;
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error("Doubao Work request timed out while waiting for the send button");
  }

  async waitForResponse(windowId, deadline) {
    while (Date.now() < deadline) {
      const state = parseJsonResult(
        await this.executeJavaScript(
          windowId,
          `JSON.stringify((() => {
            const replies = [...document.querySelectorAll('[data-testid="message_text_content"]')]
              .filter(element => !element.closest('[class*="justify-end"]'));
            const last = replies.at(-1);
            return {
              text: (last?.innerText || last?.textContent || "").trim(),
              streaming: last?.getAttribute("data-streaming") === "true"
            };
          })())`,
        ),
        "Doubao Work returned an invalid response state",
      );
      if (state.text && !state.streaming) {
        if (Buffer.byteLength(state.text, "utf8") > MAX_RESPONSE_BYTES) {
          throw new Error("Doubao Work response exceeded the 2 MiB limit");
        }
        return state.text;
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error("Doubao Work request timed out after 180 seconds");
  }

  async requestCompletion(prompt) {
    const status = this.getStatus();
    if (!status.installed) throw new Error("Doubao Work desktop is not installed");
    if (!status.automation) {
      throw new Error(
        "Doubao Work automation is disabled. Enable View > Developer > Allow JavaScript from Apple Events, then try again.",
      );
    }

    const deadline = Date.now() + this.timeoutMs;
    const windowId = await this.ensureWindow();
    const chatUrl = `doubaowork://doubaowork-chat/chat?video_digest_bridge=${Date.now()}`;
    await this.runAppleScript(NAVIGATE_WINDOW_SCRIPT, [windowId, chatUrl]);
    await this.waitForInput(windowId, deadline);
    await this.submitPrompt(windowId, prompt, deadline);
    await this.runAppleScript(MINIMIZE_WINDOW_SCRIPT, [windowId]);
    return this.waitForResponse(windowId, deadline);
  }
}

module.exports = {
  DEFAULT_APP_PATH,
  DEFAULT_PREFERENCES_PATH,
  DoubaoWorkAppleEventsController,
  friendlyAutomationError,
};
