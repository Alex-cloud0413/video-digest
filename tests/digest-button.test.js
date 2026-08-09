const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentScript = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);

class FakeElement {
  constructor({
    id = "",
    width = 100,
    height = 36,
    inMetadata = false,
    inPrimary = false,
  } = {}) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.inMetadata = inMetadata;
    this.inPrimary = inPrimary;
    this.isConnected = true;
    this.parentElement = null;
    this.children = [];
    this.style = {};
    this.listeners = {};
  }

  get firstChild() {
    return this.children[0] || null;
  }

  getBoundingClientRect() {
    return { width: this.width, height: this.height };
  }

  closest(selector) {
    if (selector === "ytd-watch-metadata" && this.inMetadata) return this;
    if (selector === "#primary" && this.inPrimary) return this;
    return null;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  insertBefore(child, before) {
    child.parentElement?.removeChild(child);
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentElement = null;
  }

  remove() {
    this.parentElement?.removeChild(this);
    this.isConnected = false;
  }
}

function createHarness() {
  const actionRows = [];
  const fallbackRows = [];
  const elements = [];
  const documentListeners = {};
  const windowListeners = {};
  const observers = [];
  const timers = new Map();
  let nextTimerId = 1;

  const document = {
    readyState: "loading",
    body: new FakeElement(),
    addEventListener(type, listener) {
      documentListeners[type] = listener;
    },
    querySelectorAll(selector) {
      if (selector === "ytd-watch-metadata #actions-inner") return actionRows;
      if (selector === "#ytd-digest-button") {
        return elements.filter(
          (element) => element.id === "ytd-digest-button" && element.isConnected,
        );
      }
      if (selector.includes("top-level-buttons-computed")) return fallbackRows;
      return [];
    },
    querySelector() {
      return null;
    },
    getElementById(id) {
      return elements.find((element) => element.id === id && element.isConnected);
    },
    createElement() {
      const element = new FakeElement();
      elements.push(element);
      return element;
    },
  };

  const context = vm.createContext({
    console,
    document,
    window: {
      location: { pathname: "/watch" },
      addEventListener(type, listener) {
        windowListeners[type] = listener;
      },
      getComputedStyle(element) {
        return {
          display: element.display || "flex",
          visibility: element.visibility || "visible",
        };
      },
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage() {
          return { success: true };
        },
      },
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      return nextTimerId++;
    },
    clearInterval() {},
  });

  vm.runInContext(contentScript, context);

  return {
    context,
    actionRows,
    fallbackRows,
    elements,
    documentListeners,
    windowListeners,
    observers,
    flushTimers() {
      const callbacks = Array.from(timers.values());
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

test("Digest button skips a hidden responsive toolbar", () => {
  const harness = createHarness();
  const hiddenRow = new FakeElement({
    id: "actions-inner",
    width: 0,
    height: 0,
    inMetadata: true,
    inPrimary: true,
  });
  const visibleRow = new FakeElement({
    id: "actions-inner",
    width: 389,
    height: 36,
    inMetadata: true,
    inPrimary: true,
  });
  harness.actionRows.push(hiddenRow, visibleRow);

  assert.equal(harness.context.findDigestButtonHost(), visibleRow);
  assert.equal(harness.context.injectDigestButton(), true);
  assert.equal(hiddenRow.children.length, 0);
  assert.equal(visibleRow.children[0].id, "ytd-digest-button");
});

test("Digest button replaces stale instances and removes duplicates", () => {
  const harness = createHarness();
  const staleRow = new FakeElement({
    id: "actions-inner",
    width: 0,
    height: 0,
    inMetadata: true,
    inPrimary: true,
  });
  const visibleRow = new FakeElement({
    id: "actions-inner",
    width: 500,
    height: 36,
    inMetadata: true,
    inPrimary: true,
  });
  harness.actionRows.push(staleRow, visibleRow);

  const staleButton = new FakeElement();
  staleButton.id = "ytd-digest-button";
  const duplicateButton = new FakeElement();
  duplicateButton.id = "ytd-digest-button";
  harness.elements.push(staleButton, duplicateButton);
  staleRow.appendChild(staleButton);
  staleRow.appendChild(duplicateButton);

  assert.equal(harness.context.injectDigestButton(), true);
  assert.equal(staleRow.children.length, 0);
  assert.equal(visibleRow.children.length, 1);
  assert.notEqual(visibleRow.children[0], staleButton);
  assert.equal(visibleRow.children[0].id, "ytd-digest-button");
  assert.equal(staleButton.isConnected, false);
  assert.equal(duplicateButton.isConnected, false);
});

test("resize reconciliation follows YouTube to the newly visible toolbar", () => {
  const harness = createHarness();
  const firstRow = new FakeElement({
    id: "actions-inner",
    width: 500,
    height: 36,
    inMetadata: true,
    inPrimary: true,
  });
  const secondRow = new FakeElement({
    id: "actions-inner",
    width: 0,
    height: 0,
    inMetadata: true,
    inPrimary: true,
  });
  harness.actionRows.push(firstRow, secondRow);

  harness.context.injectDigestButton();
  harness.context.setupDigestButtonResizeListener();
  firstRow.width = 0;
  firstRow.height = 0;
  secondRow.width = 389;
  secondRow.height = 36;

  harness.windowListeners.resize();
  harness.flushTimers();

  assert.equal(firstRow.children.length, 0);
  assert.equal(secondRow.children.length, 1);
  assert.equal(secondRow.children[0].id, "ytd-digest-button");
});

test("DOM mutation reconciliation repairs a replaced toolbar", () => {
  const harness = createHarness();
  const oldRow = new FakeElement({
    id: "actions-inner",
    width: 500,
    height: 36,
    inMetadata: true,
    inPrimary: true,
  });
  const newRow = new FakeElement({
    id: "actions-inner",
    width: 0,
    height: 0,
    inMetadata: true,
    inPrimary: true,
  });
  harness.actionRows.push(oldRow, newRow);

  harness.context.injectDigestButton();
  harness.context.setupButtonObserver();
  oldRow.width = 0;
  oldRow.height = 0;
  newRow.width = 500;
  newRow.height = 36;

  harness.observers[0].callback([]);
  harness.flushTimers();

  assert.equal(oldRow.children.length, 0);
  assert.equal(newRow.children.length, 1);
});
