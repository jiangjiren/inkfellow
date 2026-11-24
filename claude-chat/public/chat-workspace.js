const workspaceKey = `inkfellow.workspace.${location.pathname.replace(/index\.html$/, "")}`;
const tabsBar = document.getElementById("chat-tabs");
const noticeDialog = document.getElementById("chat-notices");
const liveChatTitles = new Map();
const tabDrafts = new Map();
const closedChatTabs = new Set();
const knownChatTabs = new Set();
let openedChatTabs = [];
let workspaceNotices = [];
let workspaceNoticesSince = Date.now();
try {
  const saved = JSON.parse(localStorage.getItem(workspaceKey) || "{}");
  if (Array.isArray(saved.tabs)) openedChatTabs = saved.tabs.filter(item => isRegularTab(item.id)).slice(-30);
  if (Array.isArray(saved.notices)) workspaceNotices = saved.notices.slice(0, 40);
  if (Number.isFinite(saved.noticesSince)) workspaceNoticesSince = saved.noticesSince;
  for (const tab of openedChatTabs) if (tab.saved) knownChatTabs.add(tab.id);
} catch { /* unavailable storage */ }

function isRegularTab(id) {
  return /^[a-zA-Z0-9_-]{1,96}$/.test(id || "") && id !== "strategist" && !id.startsWith("wrk_tk_");
}

function saveWorkspace() {
  try { localStorage.setItem(workspaceKey, JSON.stringify({ tabs: openedChatTabs, notices: workspaceNotices, noticesSince: workspaceNoticesSince })); } catch { }
}

function trackChatTab(id, title, saved = false) {
  if (isRegularTab(id)) {
    if (saved) knownChatTabs.add(id);
    const item = openedChatTabs.find(tab => tab.id === id);
    if (item) {
      if (title && (saved || item.title === "新对话")) item.title = title;
      item.saved ||= saved;
    } else {
      openedChatTabs = [...openedChatTabs, { id, title: title || "新对话", saved }].slice(-30);
    }
    if (currentConvId === id) closedChatTabs.delete(id);
    saveWorkspace();
  }
  renderWorkspaceTabs();
}

function saveChatDraft(id) {
  if (!id) return;
  if (promptEl.value) tabDrafts.set(id, promptEl.value);
  else tabDrafts.delete(id);
}

function restoreChatDraft(id) {
  promptEl.value = tabDrafts.get(id) || "";
  clearImages();
  quotedText = quotedSection = quotedPrefix = quotedSuffix = null;
  quoteChip.classList.remove("visible");
  syncHeight();
  syncSendButtonMode();
}

function renderWorkspaceTabs() {
  tabsBar.hidden = openedChatTabs.length === 0;
  const focused = document.activeElement.closest?.("[data-chat-tab-id]");
  const focusedId = focused?.dataset.chatTabId;
  const focusedAction = focused?.dataset.action;
  const fragment = document.createDocumentFragment();
  for (const tab of openedChatTabs) {
    const entry = document.createElement("div");
    entry.className = "chat-tab-entry";
    const activate = document.createElement("button");
    activate.type = "button";
    activate.setAttribute("role", "tab");
    activate.setAttribute("aria-selected", String(tab.id === currentConvId));
    activate.dataset.chatTabId = tab.id;
    activate.dataset.action = "select";
    activate.title = tab.title;
    activate.textContent = tab.title;
    if (liveChatTitles.has(tab.id)) {
      activate.dataset.running = "true";
      activate.setAttribute("aria-label", `${tab.title}，正在运行`);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.dataset.chatTabId = tab.id;
    close.dataset.action = "close";
    close.setAttribute("aria-label", `关闭标签 ${tab.title}`);
    close.textContent = "×";
    entry.append(activate, close);
    fragment.append(entry);
  }
  tabsBar.replaceChildren(fragment);
  if (focusedId) tabsBar.querySelector(`[data-chat-tab-id="${CSS.escape(focusedId)}"][data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
}

async function openChatTab(id, title) {
  if (id === currentConvId) return;
  const saved = knownChatTabs.has(id) || liveChatTitles.has(id);
  const conv = { id, title: title || liveChatTitles.get(id) || "新对话" };
  if (!saved) conv.messages = [];
  await loadConversation(conv);
}

tabsBar.addEventListener("click", event => {
  const control = event.target.closest("[data-chat-tab-id]");
  if (!control) return;
  const id = control.dataset.chatTabId;
  const index = openedChatTabs.findIndex(tab => tab.id === id);
  if (index < 0) return;
  if (control.dataset.action === "select") {
    void openChatTab(id, openedChatTabs[index].title);
    return;
  }
  saveChatDraft(id === currentConvId ? id : null);
  openedChatTabs.splice(index, 1);
  if (liveChatTitles.has(id)) closedChatTabs.add(id);
  saveWorkspace();
  renderWorkspaceTabs();
  if (currentConvId === id) {
    const next = openedChatTabs[Math.min(index, openedChatTabs.length - 1)];
    if (next) void openChatTab(next.id, next.title);
    else void startNewConversation();
  }
});

const noticeStatements = {
  complete: "对话已完成", completed: "工单已完成", failed: "工单执行失败",
  needs_attention: "工单等待你确认", partial: "工单待验收",
};

function addWorkspaceNotice(item) {
  if (workspaceNotices.some(notice => notice.key === item.key)) return;
  workspaceNotices.unshift({ ...item, unread: true });
  workspaceNotices = workspaceNotices.slice(0, 40);
  saveWorkspace();
  renderWorkspaceNotices();
  if (globalThis.Notification?.permission === "granted" && document.hidden) {
    try {
      const notice = new Notification(item.title, { body: item.label, tag: item.key });
      notice.onclick = () => { window.focus(); notice.close(); void openWorkspaceNotice(item); };
    } catch { /* in-page inbox stays available */ }
  }
}

function addCompletedChatNotice(id, event) {
  addWorkspaceNotice({ key: `chat:${id}:${event.requestId}`, id, title: event.title, label: noticeStatements.complete, kind: "chat" });
}

function collectTicketNotices(tickets, live = false) {
  for (const ticket of tickets) {
    if (!noticeStatements[ticket.status]) continue;
    if (!live && !(Date.parse(ticket.finishedAt || ticket.updatedAt) >= workspaceNoticesSince)) continue;
    addWorkspaceNotice({
      key: `ticket:${ticket.id}:${ticket.status}:${ticket.finishedAt || ticket.attentionReason || ticket.startedAt}`,
      id: ticket.id, title: ticket.title, label: noticeStatements[ticket.status], kind: "ticket",
    });
  }
}

function handleWorkspaceEvent(event) {
  if (event.type === "chat_activity_snapshot") {
    liveChatTitles.clear();
    for (const chat of event.chats || []) {
      if (!isRegularTab(chat.conversationId)) continue;
      liveChatTitles.set(chat.conversationId, chat.title);
      if (!closedChatTabs.has(chat.conversationId)) trackChatTab(chat.conversationId, chat.title, true);
    }
    for (const chat of event.completed || []) {
      if (isRegularTab(chat.conversationId) && Date.parse(chat.completedAt) >= workspaceNoticesSince) addCompletedChatNotice(chat.conversationId, chat);
    }
    void refreshFellowTickets().catch(() => {});
    renderWorkspaceTabs();
    return true;
  }
  if (event.type === "chat_activity" && isRegularTab(event.conversationId)) {
    const id = event.conversationId;
    if (event.status === "running") liveChatTitles.set(id, event.title);
    else liveChatTitles.delete(id);
    if (!closedChatTabs.has(id)) trackChatTab(id, event.title, true);
    if (event.status === "complete") addCompletedChatNotice(id, event);
    renderWorkspaceTabs();
    return true;
  }
  if (event.type === "ticket_updated" && event.ticket) {
    collectTicketNotices([event.ticket], true);
  }
  return false;
}

function renderWorkspaceNotices() {
  const count = workspaceNotices.filter(item => item.unread).length;
  const badge = document.getElementById("chat-unread");
  badge.textContent = String(count);
  badge.hidden = count === 0;
  const list = document.getElementById("chat-notice-list");
  list.replaceChildren();
  if (!workspaceNotices.length) {
    const empty = document.createElement("li");
    empty.textContent = "暂无通知";
    list.append(empty);
  }
  for (const item of workspaceNotices) {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${item.title} · ${item.label}`;
    if (item.unread) button.dataset.unread = "true";
    button.addEventListener("click", () => void openWorkspaceNotice(item));
    row.append(button);
    list.append(row);
  }
}

async function openWorkspaceNotice(item) {
  const stored = workspaceNotices.find(notice => notice.key === item.key);
  if (stored) stored.unread = false;
  saveWorkspace();
  renderWorkspaceNotices();
  if (noticeDialog.open) noticeDialog.close();
  if (item.kind === "ticket") {
    try {
      const detail = await fellowRequest(`tickets/${item.id}`);
      updateFellowTicket(detail.ticket);
      await loadConversation({ id: detail.ticket.workerConversationId });
    } catch (error) { showInlineError(error.message); }
  } else {
    knownChatTabs.add(item.id);
    await openChatTab(item.id, item.title);
  }
}

document.getElementById("chat-notices-open").addEventListener("click", () => noticeDialog.showModal());
document.getElementById("chat-notices-close").addEventListener("click", () => noticeDialog.close());
const noticePermission = document.getElementById("chat-notification-permission");
noticePermission.hidden = !globalThis.Notification || Notification.permission === "granted";
noticePermission.addEventListener("click", async () => {
  try {
    const result = await Notification.requestPermission();
    if (result === "granted") noticePermission.hidden = true;
    else noticePermission.textContent = "浏览器权限未开启";
  } catch { noticePermission.textContent = "当前环境仅显示站内通知"; }
});
renderWorkspaceTabs();
renderWorkspaceNotices();
saveWorkspace();
