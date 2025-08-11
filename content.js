// content.js
let enabled = false;
let autoCheck = true;
let bubbleEl = null;
let toastEl = null;
let last = { text: "", ts: 0 };

init();

async function init() {
  try {
    const resp = await sendMessageAsync({ type: "GET_ENABLED" });
    if (resp?.ok) {
      enabled = !!resp.enabled;
      autoCheck = !!resp.autoCheck;
    }
  } catch {}
  chrome.runtime.onMessage.addListener(onBgMessage);

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") destroyBubble();
  }, true);
  window.addEventListener("scroll", () => destroyBubble(), { passive: true });
}

function onBgMessage(msg) {
  if (!msg) return;
  if (msg.type === "HG_TOGGLED") {
    enabled = !!msg.payload?.enabled;
    if (!enabled) destroyBubble();
  } else if (msg.type === "SHOW_INLINE_RESULT") {
    showBubbleForSelection(msg.payload);
  } else if (msg.type === "SHOW_TOAST") {
    showToast(msg.payload?.text || "HealthGuard");
  }
}

function onMouseUp() {
  if (!enabled || !autoCheck) return;
  const text = getSelectionText();
  if (!text || text.length < 8) return;

  const now = Date.now();
  if (text === last.text && now - last.ts < 4000) return;
  last = { text, ts: now };

  showToast("Checking…");
  chrome.runtime.sendMessage({ type: "CHECK_TEXT", text }, (resp) => {
    if (!resp?.ok) return showToast("Error checking claim");
    showBubbleForSelection(resp.data);
  });
}

function getSelectionText() {
  return (window.getSelection?.().toString() || "").trim();
}

function getSelectionRect() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  const rect = range.getBoundingClientRect();
  if (rect && rect.width && rect.height) return rect;
  // fallback: create a temporary span
  const span = document.createElement("span");
  span.appendChild(document.createTextNode("\u200b"));
  range.collapse(false);
  range.insertNode(span);
  const r = span.getBoundingClientRect();
  span.parentNode.removeChild(span);
  return r;
}

function showToast(text) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.style.cssText = `
      position: fixed; z-index: 2147483647; left: 50%; transform: translateX(-50%);
      bottom: 24px; background: #111; color: #fff; padding: 10px 14px; border-radius: 999px;
      font: 12px/1.2 system-ui,-apple-system,Segoe UI,Roboto; display:none; box-shadow: 0 6px 20px rgba(0,0,0,.3);
    `;
    document.documentElement.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.display = "inline-block";
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.style.display = "none"), 2000);
}

function verdictStyles(v) {
  const map = {
    "true":   { bg: "#D1FAE5", fg: "#065F46", chip: "#10B981", label: "TRUE" },
    "false":  { bg: "#FEE2E2", fg: "#7F1D1D", chip: "#EF4444", label: "FALSE" },
    "misleading": { bg: "#FEF3C7", fg: "#7C2D12", chip: "#F59E0B", label: "MISLEADING" },
    "uncertain":  { bg: "#DBEAFE", fg: "#1E3A8A", chip: "#3B82F6", label: "UNCERTAIN" }
  };
  return map[v] || map.uncertain;
}

function destroyBubble() {
  if (bubbleEl && bubbleEl.parentNode) bubbleEl.parentNode.removeChild(bubbleEl);
  bubbleEl = null;
}

function showBubbleForSelection(data) {
  const rect = getSelectionRect();
  if (!rect) return;
  const v = (data?.verdict || "uncertain").toLowerCase();
  const reason = data?.reason || "";
  const sources = data?.sources || [];
  const st = verdictStyles(v);

  destroyBubble();
  bubbleEl = document.createElement("div");
  bubbleEl.style.cssText = `
    position: absolute; z-index: 2147483647; max-width: 420px;
    background: ${st.bg}; color: ${st.fg}; border-radius: 12px; padding: 10px 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,.18); font: 13px/1.35 system-ui,-apple-system,Segoe UI,Roboto;
  `;

  bubbleEl.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
      <span style="font-weight:800; background:${st.chip}; color:#fff; padding:2px 8px; border-radius:999px; letter-spacing:.3px;">
        ${st.label}
      </span>
      <button id="hg-close" title="Close" style="margin-left:auto; border:none; background:transparent; color:${st.fg}; cursor:pointer; font-size:16px; line-height:1;">×</button>
    </div>
    <div style="background:rgba(255,255,255,.6); color:#111; padding:8px; border-radius:8px;">
      ${escapeHTML(reason) || "No details available."}
    </div>
    <div style="margin-top:6px;">
      ${(sources || []).map(s => `<a href="${s.url}" target="_blank" rel="noreferrer noopener" style="display:block; color:${st.fg}; text-decoration:underline; word-break:break-word; margin:4px 0;">${escapeHTML(s.title || s.url)}</a>`).join("")}
    </div>
  `;

  document.documentElement.appendChild(bubbleEl);

  // position near selection
  const top = window.scrollY + rect.bottom + 8;
  const left = Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - bubbleEl.offsetWidth - 12);
  bubbleEl.style.top = `${top}px`;
  bubbleEl.style.left = `${left}px`;

  // close handlers
  bubbleEl.querySelector("#hg-close").addEventListener("click", destroyBubble, { once: true });
  setTimeout(() => {
    document.addEventListener("click", handleOutside, { capture: true, once: true });
  }, 0);
  function handleOutside(e) {
    if (!bubbleEl || bubbleEl.contains(e.target)) return;
    destroyBubble();
  }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function sendMessageAsync(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}
