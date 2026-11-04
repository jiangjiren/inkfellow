import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const source = name => html.match(new RegExp(`function ${name}\\([^]*?^}`, "m"))[0];

// Keep node identity and cloning: cached HTML creates new nodes while the JS
// reference still points at the old view. A counter-only stub misses this bug.
class Element {
  constructor(className = "") {
    this.className = className;
    this.children = [];
    this.parent = null;
  }
  appendChild(node) {
    node.remove();
    this.children.push(node);
    node.parent = this;
    return node;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this);
    this.parent = null;
  }
  querySelectorAll(selector) {
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    const matches = node => selector.startsWith("#")
      ? node.id === selector.slice(1)
      : classes.length && classes.every(name => node.className.split(" ").includes(name));
    return this.children.flatMap(node => [
      ...(matches(node) ? [node] : []), ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  set innerHTML(value) {
    this.children.forEach(node => { node.parent = null; });
    this.children = [];
    for (const match of value.matchAll(/<span class="([^"]+)"/g)) this.appendChild(new Element(match[1]));
  }
  cloneNode() {
    const copy = new Element(this.className);
    copy.id = this.id;
    for (const node of this.children) copy.appendChild(node.cloneNode());
    return copy;
  }
}

function fixture() {
  const messages = new Element();
  const bubble = messages.appendChild(new Element("msg msg-assistant"));
  bubble.appendChild(new Element("msg-body"));
  const c = vm.createContext({
    messagesEl: messages, assistantEl: bubble, genChipEl: null, isGenerating: true,
    currentConvId: "a", squadCards: new Map(),
    syncComposerAction() {}, updateBackgroundActivity() {}, postParentMessage() {}, cleanupRunningTools() {},
    scrollBottom() {},
    document: {
      createElement: () => new Element(),
      getElementById: id => c.messagesEl.querySelector(`#${id}`),
    },
  });
  vm.runInContext([
    "showGenChip", "reanchorGenChip", "removeGenChip", "ensureProgressIndicator",
    "setGenerating", "restoreConversationRuntime", "addTyping", "removeTyping",
  ].map(source).join("\n"), c);
  return c;
}

test("cached running views restore exactly one blue dot and completion removes it", () => {
  const c = fixture();
  c.showGenChip("");
  const otherConversation = c.messagesEl;
  for (let round = 0; round < 4; round++) {
    // Equivalent to serializing and restoring messagesEl.innerHTML: all nodes
    // are copies, and genChipEl belongs to the view that was just replaced.
    c.messagesEl = c.messagesEl.cloneNode();
    c.restoreConversationRuntime({ generating: true });
    c.setGenerating(true);
    assert.equal(c.messagesEl.querySelectorAll(".gen-chip").length, 1, `switch ${round + 1}`);
    assert.equal(c.genChipEl, c.messagesEl.querySelector(".gen-chip"));
  }
  c.setGenerating(false);
  assert.equal(c.messagesEl.querySelectorAll(".gen-chip").length, 0);
  assert.equal(c.genChipEl, null);
  // Cleaning the active view must not clear unrelated cached DOM nodes.
  assert.equal(otherConversation.querySelectorAll(".msg.msg-assistant").length, 1);
});

test("terminal cleanup removes untracked cached blue dots even without a live reference", () => {
  const c = fixture();
  c.showGenChip("");
  c.messagesEl = c.messagesEl.cloneNode();
  c.genChipEl = null;
  const body = c.messagesEl.querySelector(".msg-body");
  body.appendChild(body.querySelector(".gen-chip").cloneNode());
  c.setGenerating(false);
  c.setGenerating(false);
  assert.equal(c.messagesEl.querySelectorAll(".gen-chip").length, 0);
});

const indicators = c => c.messagesEl.querySelectorAll(".gen-chip").length
  + c.messagesEl.querySelectorAll("#typing").length
  + c.messagesEl.querySelectorAll(".thinking-active").length;

test("re-asserting generating mid-answer keeps the chip and adds no typing dots", () => {
  // run_attached / request_ack / request_started used to call addTyping after
  // setGenerating(true), leaving three dots under the bubble for the whole turn.
  const c = fixture();
  c.showGenChip("");
  c.setGenerating(true);
  c.addTyping();
  assert.equal(indicators(c), 1);
  assert.equal(c.messagesEl.querySelectorAll(".gen-chip").length, 1);
});

test("the chip takes over from typing dots when the first block arrives", () => {
  const c = fixture();
  c.assistantEl = null;
  c.addTyping();
  assert.equal(c.messagesEl.querySelectorAll("#typing").length, 1);
  c.assistantEl = c.messagesEl.querySelector(".msg-assistant");
  c.showGenChip("");
  assert.equal(indicators(c), 1);
  assert.equal(c.messagesEl.querySelectorAll("#typing").length, 0);
});

test("an active thinking block counts as the progress indicator", () => {
  const c = fixture();
  c.assistantEl.querySelector(".msg-body").appendChild(new Element("thinking-block thinking-active"));
  c.setGenerating(true);
  assert.equal(indicators(c), 1);
  assert.equal(c.genChipEl, null);
});

test("switching back before the turn produced output does not adopt the previous answer", () => {
  const c = fixture();
  c.messagesEl.appendChild(new Element("msg msg-user"));
  c.assistantEl = null;
  c.addTyping();
  c.messagesEl = c.messagesEl.cloneNode();
  c.restoreConversationRuntime({ generating: true, hasAssistantEl: false });
  c.setGenerating(true);
  assert.equal(c.assistantEl, null);
  assert.equal(indicators(c), 1);
  assert.equal(c.messagesEl.querySelectorAll("#typing").length, 1);
});
