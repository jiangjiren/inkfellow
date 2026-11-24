const fellowBoard = document.getElementById("fellow-board");
const fellowList = document.getElementById("fellow-tickets");
const fellowForm = document.getElementById("fellow-create");
const fellowFilter = document.getElementById("fellow-filter");
const fellowTickets = new Map();
const fellowLive = new Set(["running", "queued", "needs_attention", "stopping"]);
const fellowStatusLabels = {
  running: "执行中", queued: "排队中", needs_attention: "待关注", stopping: "停止中",
  completed: "已完成", failed: "失败", stopped: "已停止", interrupted: "上次运行中断", partial: "待验收",
};
let fellowListGeneration = 0;
let fellowSending = false;
let fellowOpeningWorker = false;

async function fellowRequest(path, body) {
  const response = await fetch(`api/fellow/${path}`, body === undefined ? { cache: "no-store" } : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || "工单请求失败。");
  return data;
}

function currentFellowTicket() {
  return currentConvId?.startsWith("wrk_tk_") ? fellowTickets.get(currentConvId.slice(4)) : null;
}

function syncFellowNavigation() {
  const isManager = currentConvId === "strategist";
  const isWorker = Boolean(currentConvId?.startsWith("wrk_tk_"));
  const ticket = currentFellowTicket();
  document.getElementById("fellow-open").setAttribute("aria-pressed", String(isManager));
  document.getElementById("fellow-context").hidden = !isManager && !isWorker;
  document.getElementById("fellow-back").hidden = !isWorker;
  document.getElementById("fellow-context-label").textContent = isWorker ? ticket?.title || "Worker 现场" : isManager ? "总管" : "";
  document.getElementById("fellow-context-status").textContent = ticket ? (fellowStatusLabels[ticket.status] || "") : "";
  document.getElementById("fellow-context-artifacts").hidden = !ticket?.artifactPaths?.length && !ticket?.changedFiles?.length;
  document.getElementById("app").dataset.fellowView = isWorker ? "worker" : isManager ? "manager" : "chat";
  promptEl.placeholder = isWorker ? "给这张工单补充要求…" : isManager ? "跟 Fellow 聊想法，或交代要派发的任务…" : "发消息给 Fellow…";

  const count = [...fellowTickets.values()].filter(item => fellowLive.has(item.status)).length;
  const countEl = document.getElementById("fellow-active-count");
  countEl.textContent = String(count);
  countEl.hidden = count === 0;
}

function handleFellowEvent(event) {
  if (event.type === "ticket_updated" || event.type === "ticket_created") {
    fellowListGeneration++;
    if (event.ticket) updateFellowTicket(event.ticket);
    return true;
  }
  if (event.type === "fellow_worker_started" || event.type === "fellow_report") {
    if (event.conversationId === currentConvId) sendHello();
    return true;
  }
  return false;
}

function updateFellowTicket(ticket) {
  const known = fellowTickets.get(ticket.id);
  if ((ticket.revision ?? 0) < (known?.revision ?? 0)) return;
  fellowTickets.set(ticket.id, ticket);
  syncFellowNavigation();
  if (fellowBoard.open) renderFellowTickets();
}

async function refreshFellowTickets() {
  const generation = ++fellowListGeneration;
  const data = await fellowRequest("tickets");
  if (generation === fellowListGeneration) fellowTickets.clear();
  for (const ticket of data.tickets ?? []) {
    const previous = fellowTickets.get(ticket.id);
    if (!previous || ticket.revision >= previous.revision) fellowTickets.set(ticket.id, ticket);
  }
  globalThis.collectTicketNotices?.([...fellowTickets.values()]);
  syncFellowNavigation();
  if (fellowBoard.open) renderFellowTickets();
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

function ticketButton(label, action) {
  const button = element("button", "", label);
  button.type = "button";
  button.dataset.fellowAction = action;
  return button;
}

function buildFellowRow(ticket) {
  const row = element("li", "fellow-ticket");
  row.dataset.ticketId = ticket.id;
  row.dataset.revision = String(ticket.revision);
  row.dataset.status = ticket.status;
  const heading = element("div", "fellow-ticket-heading");
  heading.append(element("strong", "", ticket.title), element("span", "fellow-ticket-state", fellowStatusLabels[ticket.status] || ticket.status));
  row.append(heading);
  if (ticket.profileName || ticket.model) row.append(element("small", "", [ticket.profileName, ticket.model].filter(Boolean).join(" · ")));
  const blockers = ticket.blockedBy?.map(id => fellowTickets.get(id)?.title || id) ?? [];
  const detail = ticket.error || ticket.attentionReason || (blockers.length ? `等候 ${blockers.join("、")}` : "")
    || (fellowLive.has(ticket.status) ? ticket.lastStepLabel : ticket.summary);
  if (detail) row.append(element("p", "", detail));
  if (ticket.changedFiles?.length) row.append(element("p", "", ticket.changedFiles.slice(0, 5).join("\n")));
  const actions = element("div", "fellow-ticket-actions");
  actions.append(ticketButton("进入现场", "open"));
  if (ticket.artifactPaths?.length || ticket.changedFiles?.length) actions.append(ticketButton("产物", "artifacts"));
  if (fellowLive.has(ticket.status) && ticket.status !== "stopping") actions.append(ticketButton("停止", "stop"));
  if (["failed", "stopped", "interrupted"].includes(ticket.status)) actions.append(ticketButton("重试", "retry"));
  if (!fellowLive.has(ticket.status)) actions.append(ticketButton(ticket.archivedAt ? "取消归档" : "归档", ticket.archivedAt ? "unarchive" : "archive"));
  row.append(actions);
  return row;
}

function renderFellowTickets() {
  const filter = fellowFilter.value;
  const tickets = [...fellowTickets.values()].filter(ticket => {
    if (filter === "archive") return Boolean(ticket.archivedAt);
    if (ticket.archivedAt) return false;
    if (filter === "active") return true;
    if (filter === "finished") return !fellowLive.has(ticket.status);
    return ticket.status === filter;
  });
  tickets.sort((a, b) => Number(fellowLive.has(b.status)) - Number(fellowLive.has(a.status))
    || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const rows = new Map([...fellowList.children].map(row => [row.dataset.ticketId, row]));
  if (!tickets.length) {
    if (fellowList.children.length !== 1 || !fellowList.firstElementChild?.classList.contains("fellow-empty")) {
      fellowList.replaceChildren(element("li", "fellow-empty", filter === "active"
        ? "还没有工单。可从这里新建，或请 Fellow 拆分任务并派发。" : "没有符合当前筛选的工单。"));
    }
    return;
  }
  const focus = document.activeElement.closest?.("[data-fellow-action]");
  const focusId = focus?.closest("[data-ticket-id]")?.dataset.ticketId;
  let focusReplacement;
  for (const [index, ticket] of tickets.entries()) {
    let row = rows.get(ticket.id);
    rows.delete(ticket.id);
    if (row?.dataset.revision !== String(ticket.revision)) {
      const next = buildFellowRow(ticket);
      row?.replaceWith(next);
      row = next;
      if (focusId === ticket.id) focusReplacement = row.querySelector(`[data-fellow-action="${focus.dataset.fellowAction}"]`) ?? row.querySelector("button");
    }
    if (fellowList.children[index] !== row) fellowList.insertBefore(row, fellowList.children[index] ?? null);
  }
  for (const row of rows.values()) row.remove();
  const nextFocus = focusReplacement ?? (focus?.isConnected ? focus : null);
  if (nextFocus && document.activeElement !== nextFocus) nextFocus.focus({ preventScroll: true });
}

function fellowBoardStatus(text) {
  document.getElementById("fellow-board-status").textContent = text;
}

function openFellowBoard() {
  if (fellowBoard.open) return;
  closeHistoryPanel();
  fellowBoard.showModal();
  fellowBoardStatus("正在加载工单…");
  renderFellowTickets();
  void refreshFellowTickets().then(() => fellowBoardStatus(""), error => fellowBoardStatus(error.message));
}

async function sendWorkerInstruction(text) {
  const ticket = currentFellowTicket();
  if (!ticket || fellowSending) return;
  const mentioned = [...selectedMentionFiles.values()];
  const parts = [
    noteContextEnabled && currentNoteFile ? `当前查看的文件：${currentNoteFile}` : "",
    mentioned.length ? `引用文件：${mentioned.map(file => JSON.stringify(file.path)).join("、")}` : "",
    quotedText ? `用户引用的文段：${quotedText}` : "",
    text,
  ].filter(Boolean);
  fellowSending = true;
  const conversationId = currentConvId;
  try {
    const result = await fellowRequest(`tickets/${ticket.id}/message`, {
      instruction: parts.join("\n\n"),
      displayText: text,
      requestId: `user_${crypto.randomUUID?.() ?? genId()}`,
      images: pendingImages.map(({ data, mediaType }) => ({ data, mediaType })),
    });
    if (conversationId !== currentConvId) return;
    if (promptEl.value.trim() === text) {
      promptEl.value = "";
      clearImages();
      clearMentionFiles();
      quotedText = quotedSection = quotedPrefix = quotedSuffix = null;
      quoteChip.classList.remove("visible");
      syncHeight();
      syncSendButtonMode();
    }
    if (result.delivery === "queued" || result.status === "queued") {
      document.getElementById("fellow-context-status").textContent = "补充要求已排队";
    }
    sendHello();
  } catch (error) {
    if (conversationId === currentConvId) showInlineError(error.message);
  } finally {
    fellowSending = false;
  }
}

async function stopFellowWorker() {
  const ticket = currentFellowTicket();
  if (!ticket) return;
  try { await fellowRequest(`tickets/${ticket.id}/stop`, {}); }
  catch (error) { showInlineError(error.message); }
}

document.getElementById("fellow-open").addEventListener("click", () => {
  if (currentConvId !== "strategist") void loadConversation({ id: "strategist" });
});
document.getElementById("fellow-board-open").addEventListener("click", openFellowBoard);
document.getElementById("fellow-back").addEventListener("click", openFellowBoard);
document.getElementById("fellow-board-close").addEventListener("click", () => fellowBoard.close());
fellowFilter.addEventListener("change", renderFellowTickets);

document.getElementById("fellow-create-open").addEventListener("click", async () => {
  fellowForm.hidden = !fellowForm.hidden;
  if (fellowForm.hidden) return;
  fellowForm.elements.title.focus();
  try {
    const profiles = await fellowRequest("profiles");
    fellowForm.elements.profileId.replaceChildren(...profiles.map(profile => new Option(profile.name, profile.id)));
    if (profiles.some(profile => profile.id === getActiveProfile()?.id)) fellowForm.elements.profileId.value = getActiveProfile().id;
  } catch (error) { fellowBoardStatus(error.message); }
});

fellowForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = fellowForm.querySelector("button[type=submit]");
  const form = new FormData(fellowForm);
  button.disabled = true;
  try {
    await fellowRequest("tickets", {
      title: form.get("title"), brief: form.get("brief"),
      writeScope: String(form.get("writeScope") || "").split(/[,，]/).map(item => item.trim()).filter(Boolean),
      profileId: form.get("profileId") || undefined,
    });
    fellowForm.reset();
    fellowForm.hidden = true;
    fellowFilter.value = "active";
    await refreshFellowTickets();
    fellowBoardStatus("已派出工单。");
  } catch (error) { fellowBoardStatus(error.message); }
  finally { button.disabled = false; }
});

fellowList.addEventListener("click", async event => {
  const button = event.target.closest("[data-fellow-action]");
  const ticket = fellowTickets.get(button?.closest("[data-ticket-id]")?.dataset.ticketId);
  if (!ticket) return;
  const action = button.dataset.fellowAction;
  if (action === "artifacts") {
    void openFellowArtifacts(ticket);
    return;
  }
  if (action === "open") {
    if (fellowOpeningWorker) return;
    fellowOpeningWorker = true;
    try {
      if (currentConvId !== ticket.workerConversationId) await loadConversation({ id: ticket.workerConversationId });
      if (currentConvId === ticket.workerConversationId) fellowBoard.close();
    } finally { fellowOpeningWorker = false; }
    return;
  }
  button.disabled = true;
  try {
    const result = await fellowRequest(`tickets/${ticket.id}/${action}`, {});
    if (result.ticket) updateFellowTicket(result.ticket);
    else await refreshFellowTickets();
  } catch (error) { fellowBoardStatus(error.message); }
  finally { button.disabled = false; }
});

const artifactDialog = document.getElementById("fellow-artifact-dialog");
const artifactList = document.getElementById("fellow-artifact-list");
let artifactRequest = 0;
document.getElementById("fellow-artifact-close").addEventListener("click", () => artifactDialog.close());
document.getElementById("fellow-context-artifacts").addEventListener("click", () => {
  const ticket = currentFellowTicket();
  if (ticket) void openFellowArtifacts(ticket);
});

async function openFellowArtifacts(ticket) {
  const request = ++artifactRequest;
  if (!artifactDialog.open) artifactDialog.showModal();
  document.getElementById("fellow-artifact-title").textContent = `工单产物 · ${ticket.title}`;
  artifactList.replaceChildren(element("li", "", "正在加载…"));
  try {
    const data = await fellowRequest(`tickets/${ticket.id}/artifacts`);
    if (request !== artifactRequest || !artifactDialog.open) return;
    artifactList.replaceChildren();
    if (!data.artifacts.length) artifactList.append(element("li", "", "暂无可访问的产物。"));
    for (const entry of data.artifacts) {
      const row = element("li");
      row.append(element("span", "artifact-name", entry.name));
      const href = `api/fellow/tickets/${ticket.id}/artifacts/${entry.id}`;
      if (entry.preview) {
        const preview = element("a", "", "预览");
        preview.href = href;
        preview.target = "_blank";
        preview.rel = "noopener";
        row.append(preview);
      }
      const download = element("a", "", "下载");
      download.href = href + "?download=1";
      row.append(download);
      artifactList.append(row);
    }
  } catch (error) {
    if (request === artifactRequest && artifactDialog.open) artifactList.replaceChildren(element("li", "", error.message));
  }
}

syncFellowNavigation();
void refreshFellowTickets().catch(() => {});
