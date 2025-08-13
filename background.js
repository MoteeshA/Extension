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
    if (e.key === "Escape") {
      destroyBubble();
      closeCapturePanel();
      endRegionCapture();
    }
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
  } else if (msg.type === "START_REGION_CAPTURE") {
    startRegionCapture();
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

  const top = window.scrollY + rect.bottom + 8;
  const left = Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - bubbleEl.offsetWidth - 12);
  bubbleEl.style.top = `${top}px`;
  bubbleEl.style.left = `${left}px`;

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

/* ============================
   NEW: Region Capture + Panel
   ============================ */
const API_IMAGE = "http://192.168.1.6:8000/check_image";

let rg = { overlay: null, box: null, start: null, end: null, active: false };
let capturePanelRoot = null;

function startRegionCapture() {
  if (rg.active) return;
  rg.active = true;

  const ov = document.createElement("div");
  ov.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483646; cursor: crosshair;
    background: rgba(0,0,0,.1);
  `;
  rg.overlay = ov;

  const box = document.createElement("div");
  box.style.cssText = `
    position: fixed; border: 2px solid #4F46E5; background: rgba(99,102,241,.15);
    pointer-events: none; display: none;
  `;
  rg.box = box;

  document.documentElement.appendChild(ov);
  document.documentElement.appendChild(box);

  const onMouseDown = (e) => {
    rg.start = { x: e.clientX, y: e.clientY };
    rg.end = { x: e.clientX, y: e.clientY };
    drawBox();
    box.style.display = "block";
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
  };
  const onMouseMove = (e) => {
    rg.end = { x: e.clientX, y: e.clientY };
    drawBox();
  };
  const onMouseUp = async () => {
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    ov.removeEventListener("mousedown", onMouseDown, true);

    const rect = currentRect();
    endRegionCapture();
    if (rect.w < 8 || rect.h < 8) { return; }

    const cap = await captureVisibleTab();
    if (!cap?.ok) { showToast("Capture failed"); return; }

    const cropped = await cropDataUrl(cap.dataUrl, rect);
    openCapturePanel(cropped);
  };

  ov.addEventListener("mousedown", onMouseDown, true);

  const drawBox = () => {
    const r = currentRect();
    box.style.left   = r.x + "px";
    box.style.top    = r.y + "px";
    box.style.width  = r.w + "px";
    box.style.height = r.h + "px";
  };

  const currentRect = () => {
    const x1 = Math.min(rg.start.x, rg.end.x);
    const y1 = Math.min(rg.start.y, rg.end.y);
    const x2 = Math.max(rg.start.x, rg.end.x);
    const y2 = Math.max(rg.start.y, rg.end.y);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  };
}

function endRegionCapture() {
  if (rg.box && rg.box.parentNode) rg.box.parentNode.removeChild(rg.box);
  if (rg.overlay && rg.overlay.parentNode) rg.overlay.parentNode.removeChild(rg.overlay);
  rg.box = rg.overlay = null;
  rg.active = false;
}

function captureVisibleTab() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB" }, resolve);
  });
}

async function cropDataUrl(dataUrl, rect) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const dpr = window.devicePixelRatio || 1;
  const sx = rect.x * dpr;
  const sy = rect.y * dpr;
  const sw = rect.w * dpr;
  const sh = rect.h * dpr;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

function closeCapturePanel() {
  if (capturePanelRoot && capturePanelRoot.parentNode) {
    capturePanelRoot.parentNode.removeChild(capturePanelRoot);
  }
  capturePanelRoot = null;
}

function openCapturePanel(croppedDataUrl) {
  closeCapturePanel();

  const root = document.createElement("div");
  root.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.35);
    display: flex; align-items: center; justify-content: center;
  `;
  capturePanelRoot = root;

  const panel = document.createElement("div");
  panel.style.cssText = `
    width: min(92vw, 1100px); height: min(90vh, 720px); background: #fff; color: #111;
    border-radius: 16px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.3);
    display: grid; grid-template-columns: 1fr 1fr; gap: 0; position: relative;
  `;

  const topbar = document.createElement("div");
  topbar.style.cssText = `
    position:absolute; top:0; left:0; right:0; height:48px; display:flex; align-items:center;
    padding:0 12px; border-bottom:1px solid #eee; background:#fafafa; z-index:1;
  `;
  topbar.innerHTML = `
    <div style="font-weight:700;">HealthGuard – Capture</div>
    <div style="margin-left:auto; display:flex; gap:8px;">
      <button id="hg-run" style="padding:8px 12px; border:none; background:#111; color:#fff; border-radius:8px; cursor:pointer;">Check</button>
      <button id="hg-close-panel" style="padding:8px 12px; border:1px solid #ddd; background:#fff; color:#111; border-radius:8px; cursor:pointer;">Close</button>
    </div>
  `;

  const left = document.createElement("div");
  left.style.cssText = "background:#0b0b0b; display:flex; align-items:center; justify-content:center; padding-top:48px;";
  const img = document.createElement("img");
  img.src = croppedDataUrl;
  img.alt = "Captured";
  img.style.cssText = "max-width:100%; max-height:calc(100% - 48px); object-fit:contain;";
  left.appendChild(img);

  const right = document.createElement("div");
  right.style.cssText = "padding:56px 16px 16px; overflow:auto;";
  right.innerHTML = `
    <div style="font-size:12px; color:#555; margin-bottom:6px;">OCR + Verification</div>
    <div id="hg-verdict-chip" style="display:inline-block; padding:6px 10px; border-radius:999px; font-weight:800; color:#fff; background:#3B82F6; letter-spacing:.3px;">PENDING</div>
    <div style="margin-top:10px; font-weight:700;">Reason</div>
    <div id="hg-reason" style="background:#f7f7f7; padding:8px; border-radius:8px; min-height:64px;"></div>
    <div style="margin-top:10px; font-weight:700;">Sources</div>
    <div id="hg-sources"></div>
    <div style="margin-top:10px; font-weight:700;">OCR Text</div>
    <pre id="hg-ocr" style="white-space:pre-wrap; background:#fafafa; border:1px solid #eee; border-radius:8px; padding:8px; max-height:160px; overflow:auto;"></pre>
  `;

  panel.appendChild(left);
  panel.appendChild(right);
  panel.appendChild(topbar);
  root.appendChild(panel);
  document.documentElement.appendChild(root);

  root.addEventListener("click", (e) => {
    if (e.target === root) closeCapturePanel();
  });
  topbar.querySelector("#hg-close-panel").addEventListener("click", closeCapturePanel);
  const runBtn = topbar.querySelector("#hg-run");
  runBtn.addEventListener("click", () => runImageCheck(croppedDataUrl, right));

  // auto-run once opened
  runImageCheck(croppedDataUrl, right);
}

async function runImageCheck(dataUrl, rightEl) {
  const chip = rightEl.querySelector("#hg-verdict-chip");
  const reason = rightEl.querySelector("#hg-reason");
  const sources = rightEl.querySelector("#hg-sources");
  const ocr = rightEl.querySelector("#hg-ocr");

  chip.textContent = "CHECKING…";
  chip.style.background = "#6B7280"; // gray
  reason.textContent = "";
  sources.innerHTML = "";
  ocr.textContent = "";

  try {
    const r = await fetch(API_IMAGE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl })
    });
    if (!r.ok) throw new Error("Bad response");
    const data = await r.json();

    const v = (data.verdict || "uncertain").toLowerCase();
    const st = verdictStyles(v);
    chip.textContent = (st.label || "UNCERTAIN");
    chip.style.background = st.chip;

    reason.textContent = data.reason || "";
    sources.innerHTML = (data.sources || [])
      .map(s => `<a href="${s.url}" target="_blank" rel="noreferrer" style="display:block; margin:4px 0;">${escapeHTML(s.title || s.url)}</a>`)
      .join("");
    ocr.textContent = data.ocr_text || "";
  } catch (e) {
    chip.textContent = "ERROR";
    chip.style.background = "#EF4444";
    reason.textContent = "Could not verify right now.";
    sources.innerHTML = "";
    ocr.textContent = "";
  }
}
