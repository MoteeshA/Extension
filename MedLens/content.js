// content.js
let enabled = false;
let autoCheck = true;
let bubbleEl = null;
let toastEl = null;
let last = { text: "", ts: 0 };
let theSources = []; // keep defined before use

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
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") {
        destroyBubble();
        closeCapturePanel();
        endRegionCapture();
      }
    },
    true
  );
  window.addEventListener("scroll", () => destroyBubble(), { passive: true });

  injectStyles(); // ensure highlight styles exist
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
  } else if (msg.type === "SCAN_PAGE" || msg.type === "SCAN_FULL_PAGE") {
    scanFullPage();
  } else if (msg.type === "CLEAR_HIGHLIGHTS") {
    clearHighlights();
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
    if (!resp?.ok) return showToast(resp?.error || "Error checking claim");
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

  // fallback to zero-width space insertion
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
    "true":       { bg: "#D1FAE5", fg: "#065F46", chip: "#10B981", label: "TRUE" },
    "false":      { bg: "#FEE2E2", fg: "#7F1D1D", chip: "#EF4444", label: "FALSE" },
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
  theSources = data?.sources || [];
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
      ${(theSources || []).map(s => `<a href="${s.url}" target="_blank" rel="noreferrer noopener" style="display:block; color:${st.fg}; text-decoration:underline; word-break:break-word; margin:4px 0;">${escapeHTML(s.title || s.url)}</a>`).join("")}
    </div>
  `;

  document.documentElement.appendChild(bubbleEl);

  const top = window.scrollY + rect.bottom + 8;
  const left = Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - bubbleEl.offsetWidth - 12);
  bubbleEl.style.top = `${top}px`;
  bubbleEl.style.left = `${left}px`;

  bubbleEl.querySelector("#hg-close").addEventListener("click", destroyBubble, { once: true });
  setTimeout(() => document.addEventListener("click", handleOutside, { capture: true, once: true }), 0);
  function handleOutside(e) {
    if (!bubbleEl || bubbleEl.contains(e.target)) return;
    destroyBubble();
  }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// --- hardened to surface runtime.lastError (so scans don’t silently fail)
function sendMessageAsync(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn("[HG/content] runtime.lastError:", chrome.runtime.lastError.message);
          resolve(undefined);
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      console.error("[HG/content] sendMessage threw:", e);
      resolve(undefined);
    }
  });
}

/* ============================
   Region Capture + Panel
   ============================ */

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
    if (rect.w < 8 || rect.h < 8) return;

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
    const sx = rg.start?.x ?? 0;
    const sy = rg.start?.y ?? 0;
    const ex = rg.end?.x ?? sx;
    const ey = rg.end?.y ?? sy;
    const x1 = Math.min(sx, ex);
    const y1 = Math.min(sy, ey);
    const x2 = Math.max(sx, ex);
    const y2 = Math.max(sy, ey);
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

// Crop, then COMPRESS & RESIZE to keep payload small
async function cropDataUrl(dataUrl, rect) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const dpr = window.devicePixelRatio || 1;
  const sx = rect.x * dpr;
  const sy = rect.y * dpr;
  const sw = rect.w * dpr;
  const sh = rect.h * dpr;

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.max(1, Math.round(sw));
  cropCanvas.height = Math.max(1, Math.round(sh));
  cropCanvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);

  const maxSide = 1600;
  let tw = cropCanvas.width;
  let th = cropCanvas.height;
  if (Math.max(tw, th) > maxSide) {
    const scale = maxSide / Math.max(tw, th);
    tw = Math.max(1, Math.round(tw * scale));
    th = Math.max(1, Math.round(th * scale));
  }

  const outCanvas = document.createElement("canvas");
  outCanvas.width = tw;
  outCanvas.height = th;
  outCanvas.getContext("2d").drawImage(cropCanvas, 0, 0, tw, th);

  return outCanvas.toDataURL("image/jpeg", 0.7);
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

    <div style="margin-top:12px; font-weight:700;">Ask by Voice or Text</div>
    <div id="hg-voice" style="border:1px dashed #ddd; border-radius:10px; padding:10px; background:#fafafa;">
      <div style="display:flex; gap:8px; align-items:center;">
        <input id="hg-voice-input" type="text" placeholder="Ask or paste a claim..." 
               style="flex:1; padding:10px 12px; border:1px solid #ddd; border-radius:8px; background:#fff; color:#111;" />
        <button id="hg-voice-mic" title="Speak" 
                style="width:42px; height:42px; border:none; border-radius:10px; background:#111; color:#fff; cursor:pointer;">🎤</button>
        <button id="hg-voice-search" 
                style="padding:10px 12px; border:1px solid #ddd; border-radius:10px; background:#fff; cursor:pointer;">Search</button>
      </div>
      <div id="hg-voice-result" style="margin-top:10px; display:none;">
        <div id="hg-voice-badge" style="display:inline-block; padding:4px 8px; border-radius:999px; font-weight:800; color:#fff; background:#3B82F6; letter-spacing:.3px;">UNCERTAIN</div>
        <div style="margin-top:6px; font-weight:700;">Reason</div>
        <div id="hg-voice-reason" style="background:#fff; border:1px solid #eee; border-radius:8px; padding:8px;"></div>
        <div style="margin-top:6px; font-weight:700;">Sources</div>
        <div id="hg-voice-sources"></div>
      </div>
      <audio id="hg-voice-audio" playsinline preload="auto" style="display:none;"></audio>
    </div>
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

  runImageCheck(croppedDataUrl, right);
  setupVoiceBlock(right);
}

// -------- PROXIED image check via background --------
async function runImageCheck(dataUrl, rightEl) {
  const chip    = rightEl.querySelector("#hg-verdict-chip");
  const reason  = rightEl.querySelector("#hg-reason");
  const sources = rightEl.querySelector("#hg-sources");
  const ocr     = rightEl.querySelector("#hg-ocr");

  chip.textContent = "CHECKING…";
  chip.style.background = "#6B7280";
  reason.textContent = "";
  sources.innerHTML = "";
  ocr.textContent = "";

  try {
    const resp = await sendMessageAsync({ type: "CHECK_IMAGE", image: dataUrl });
    if (!resp?.ok) throw new Error(resp?.error || "Request failed");
    const data = resp.data || {};

    const v  = (data.verdict || "uncertain").toLowerCase();
    const st = verdictStyles(v);
    chip.textContent = st.label || "UNCERTAIN";
    chip.style.background = st.chip;

    reason.textContent = data.reason || "";
    sources.innerHTML = (data.sources || [])
      .map(s => `<a href="${s.url}" target="_blank" rel="noreferrer" style="display:block; margin:4px 0;">${escapeHTML(s.title || s.url)}</a>`)
      .join("");
    ocr.textContent = data.ocr_text || "";
  } catch (e) {
    const msg = e?.message || "Unknown failure";
    chip.textContent = "ERROR";
    chip.style.background = "#EF4444";
    reason.textContent = msg;
    sources.innerHTML = "";
    ocr.textContent = "";
    console.error("[HG/content] CHECK_IMAGE failed:", e);
  }
}

/* ============================
   Voice/search helpers (+ Swara TTS via background)
   ============================ */
function setupVoiceBlock(scopeEl) {
  const input   = scopeEl.querySelector("#hg-voice-input");
  const micBtn  = scopeEl.querySelector("#hg-voice-mic");
  const goBtn   = scopeEl.querySelector("#hg-voice-search");
  const vWrap   = scopeEl.querySelector("#hg-voice-result");
  const vBadge  = scopeEl.querySelector("#hg-voice-badge");
  const vReason = scopeEl.querySelector("#hg-voice-reason");
  const vSrc    = scopeEl.querySelector("#hg-voice-sources");
  const audioEl = scopeEl.querySelector("#hg-voice-audio");

  async function playSwaraOrFallback(textToSpeak) {
    if (!textToSpeak) return;
    try {
      const ttsResp = await sendMessageAsync({
        type: "TTS_SWARA",
        text: textToSpeak,
        voice: "hi-IN-SwaraNeural"
      });
      if (ttsResp?.ok && ttsResp.audioUrl) {
        audioEl.src = ttsResp.audioUrl;
        await audioEl.play().catch(() => {});
        return;
      }
      const u = new SpeechSynthesisUtterance(textToSpeak);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      try {
        const u = new SpeechSynthesisUtterance(textToSpeak);
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch {}
    }
  }

  const submit = async () => {
    const text = (input.value || "").trim();
    if (!text) return;
    const restore = goBtn.textContent; goBtn.textContent = "Checking…"; goBtn.disabled = true;

    try {
      const resp = await sendMessageAsync({ type: "CHECK_TEXT", text });
      if (!resp?.ok) throw new Error(resp?.error || "Request failed");
      const data = resp.data || {};
      const v = (data.verdict || "uncertain").toLowerCase();
      const st = verdictStyles(v);
      vBadge.textContent = st.label; vBadge.style.background = st.chip;
      vReason.textContent = data.reason || "";
      vSrc.innerHTML = (data.sources || []).map(s => `<a href="${s.url}" target="_blank" rel="noreferrer" style="display:block; margin:4px 0;">${escapeHTML(s.title || s.url)}</a>`).join("");
      vWrap.style.display = "block";

      const utter = `${st.label}. ${data.reason || ""}`;
      playSwaraOrFallback(utter);
    } catch (e) {
      vWrap.style.display = "block";
      vBadge.textContent = "ERROR"; vBadge.style.background = "#EF4444";
      vReason.textContent = String(e?.message || "Failed to check.");
      vSrc.innerHTML = "";
    } finally {
      goBtn.textContent = restore; goBtn.disabled = false;
    }
  };

  goBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  // mic support (Web Speech API)
  let recog = null, listening = false;
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;

  const setMicOn = (on) => {
    listening = on;
    micBtn.textContent = on ? "⏹" : "🎤";
    micBtn.style.background = on ? "#EF4444" : "#111";
    micBtn.title = on ? "Stop" : "Speak";
  };

  micBtn.addEventListener("click", () => {
    if (!Ctor) { showToast("Use Chrome/Edge for mic"); return; }
    if (listening) { try { recog.stop(); } catch {} return; }

    recog = new Ctor();
    recog.lang = navigator.language || "en-IN";
    recog.interimResults = true; recog.continuous = true; recog.maxAlternatives = 1;

    input.focus();
    setMicOn(true);

    let finals = [];
    recog.onresult = (ev) => {
      let finalSoFar = finals.join(" ");
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i], a = r[0];
        if (r.isFinal) { finals.push(a.transcript.trim()); finalSoFar = finals.join(" "); }
        else { interim += a.transcript; }
      }
      const combined = (finalSoFar + " " + interim).trim();
      input.value = combined;
    };
    recog.onerror = () => { try { recog.stop(); } catch {} };
    recog.onend = () => { setMicOn(false); submit(); };

    try { recog.start(); } catch {}
  });
}

/* ============================
   Full-page scanning & highlights (batch + robust wrapping)
   ============================ */

let HG_HIGHLIGHTED = []; // [{span, verdict, reason, sources}]
let HG_LEGEND = null;

function injectStyles() {
  if (document.getElementById("hg-style")) return;
  const st = document.createElement("style");
  st.id = "hg-style";
  st.textContent = `
    .hg-mark { padding: 0 .15em; border-radius: .25em; cursor: help; }
    .hg-true { background: #D1FAE5; box-shadow: inset 0 0 0 2px #10B98166; }
    .hg-false { background: #FEE2E2; box-shadow: inset 0 0 0 2px #EF444466; }
    .hg-misleading { background: #FEF3C7; box-shadow: inset 0 0 0 2px #F59E0B66; }
    .hg-uncertain { background: #DBEAFE; box-shadow: inset 0 0 0 2px #3B82F666; }
    .hg-tip { position: absolute; z-index: 2147483647; background:#111; color:#fff; padding:6px 8px; border-radius:6px; font:12px/1.2 system-ui,-apple-system,Segoe UI,Roboto; max-width:320px; }
    .hg-legend { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; background:#fff; color:#111; border:1px solid #eee; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.15); padding:10px 12px; font:12px system-ui,-apple-system,Segoe UI,Roboto; }
    .hg-legend strong { font-weight:800; }
    .hg-legend .row { display:flex; align-items:center; gap:8px; margin:4px 0; }
    .hg-legend .dot { width:14px; height:14px; border-radius:999px; display:inline-block; }
  `;
  document.documentElement.appendChild(st);
}

function clearHighlights() {
  HG_HIGHLIGHTED.forEach(h => {
    const span = h.span;
    if (!span || !span.parentNode) return;
    const txt = document.createTextNode(span.textContent);
    span.parentNode.replaceChild(txt, span);
    span.normalize?.();
  });
  HG_HIGHLIGHTED = [];
  if (HG_LEGEND && HG_LEGEND.parentNode) HG_LEGEND.parentNode.removeChild(HG_LEGEND);
  HG_LEGEND = null;
  showToast("Cleared HealthGuard highlights");
}

async function scanFullPage() {
  injectStyles();
  clearHighlights();

  const nodes = collectVisibleTextNodes(document.body);
  const items = sliceIntoSentences(nodes, 12 /*minLen*/, 280 /*maxLen*/);
  if (items.length === 0) { showToast("No readable text found"); return; }

  const MAX_ITEMS   = 200;
  const BATCH_SIZE  = 12;
  const CONCURRENCY = 2;

  const work = items.slice(0, MAX_ITEMS);
  showToast(`Scanning ${work.length} sentences…`);

  for (let i = 0; i < work.length; i += BATCH_SIZE) {
    const chunk      = work.slice(i, i + BATCH_SIZE);
    const chunkTexts = chunk.map(c => c.text);

    const resp = await sendMessageAsync({
      type: "CHECK_BATCH",
      items: chunkTexts,
      concurrency: CONCURRENCY
    });

    if (!resp || !resp.ok || !Array.isArray(resp.results)) {
      console.warn("[HG/content] Bad batch response:", resp);
      showToast(`Scan failed: ${resp?.error || "unknown message type"}`);
      return;
    }

    applyChunkResults(chunk, resp.results);
    showToast(`Scanning… ${Math.min(i + BATCH_SIZE, work.length)} / ${work.length}`);
    await new Promise(r => setTimeout(r, 50));
  }

  ensureLegend();
  showToast("Scan complete");
}

function applyChunkResults(chunk, results) {
  const byNode = new Map();
  for (let i = 0; i < chunk.length; i++) {
    const item = chunk[i];
    const r = results[i];
    if (!r || !r.ok || !r.value) continue;

    const verdict = (r.value.verdict || "uncertain").toLowerCase();
    const payload = {
      start: item.start,
      end: item.end,
      verdict,
      reason: r.value.reason || "",
      sources: r.value.sources || []
    };

    if (!byNode.has(item.node)) byNode.set(item.node, []);
    byNode.get(item.node).push(payload);
  }

  for (const [node, arr] of byNode.entries()) {
    arr.sort((a, b) => b.start - a.start);
    for (const seg of arr) {
      try {
        const span = safeWrapRange(node, seg.start, seg.end, `hg-mark hg-${seg.verdict}`);
        attachTooltip(span, seg.verdict.toUpperCase(), seg.reason, seg.sources);
        HG_HIGHLIGHTED.push({ span, verdict: seg.verdict, reason: seg.reason, sources: seg.sources });
      } catch (e) {
        // DOM mutated mid-scan; skip
      }
    }
  }
}

function ensureLegend() {
  if (HG_LEGEND) return;
  const wrap = document.createElement("div");
  wrap.className = "hg-legend";
  wrap.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
      <strong>HealthGuard scan</strong>
      <button id="hg-clear" style="margin-left:auto; background:#fff; border:1px solid #ddd; border-radius:8px; padding:4px 8px; cursor:pointer;">Clear</button>
    </div>
    <div class="row"><span class="dot" style="background:#D1FAE5; box-shadow: inset 0 0 0 2px #10B98166;"></span> TRUE</div>
    <div class="row"><span class="dot" style="background:#FEE2E2; box-shadow: inset 0 0 0 2px #EF444466;"></span> FALSE</div>
    <div class="row"><span class="dot" style="background:#FEF3C7; box-shadow: inset 0 0 0 2px #F59E0B66;"></span> MISLEADING</div>
    <div class="row"><span class="dot" style="background:#DBEAFE; box-shadow: inset 0 0 0 2px #3B82F666;"></span> UNCERTAIN</div>
  `;
  wrap.querySelector("#hg-clear").addEventListener("click", clearHighlights);
  document.documentElement.appendChild(wrap);
  HG_LEGEND = wrap;
}

function collectVisibleTextNodes(root) {
  const SKIP_NAMES = new Set([
    "SCRIPT","STYLE","NOSCRIPT","IFRAME","SVG","CANVAS","VIDEO","AUDIO",
    "CODE","PRE","TEXTAREA","INPUT","SELECT","BUTTON","OPTION","DATALIST",
    "MATH","PICTURE"
  ]);
  const SKIP_SECTIONS = new Set(["NAV","HEADER","FOOTER","ASIDE"]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;

      if (p.closest("a") && n.nodeValue.trim().length < 20) return NodeFilter.FILTER_REJECT;

      const name = p.tagName;
      if (SKIP_NAMES.has(name) || SKIP_SECTIONS.has(name)) return NodeFilter.FILTER_REJECT;
      if (p.isContentEditable) return NodeFilter.FILTER_REJECT;

      const rect = p.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(p);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return NodeFilter.FILTER_REJECT;

      if (p.closest("img, picture, svg, canvas, video, audio")) return NodeFilter.FILTER_REJECT;

      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const out = [];
  let node;
  while ((node = walker.nextNode())) out.push(node);
  return out;
}

function sliceIntoSentences(nodes, minLen = 12, maxLen = 280) {
  const items = [];
  const splitter = /(?<=[\.\!\?])\s+(?=[A-Z0-9])|(?<=;)\s+|(?<=:)\s+|(?<=\))\s+(?=[A-Z0-9])/g;
  for (const n of nodes) {
    const raw = n.nodeValue.replace(/\s+/g, " ").trim();
    if (!raw) continue;
    let cursor = 0;
    const parts = raw.split(splitter);
    for (const part of parts) {
      const t = part.trim();
      if (!t) { cursor += part.length + 1; continue; }
      if (t.length < minLen) { cursor += part.length + 1; continue; }

      const chunks = chunkString(t, maxLen);
      for (const c of chunks) {
        const start = raw.indexOf(c, cursor);
        if (start === -1) continue;
        const end = start + c.length;
        items.push({ node: n, start, end, text: c });
        cursor = end;
      }
    }
  }
  return items.slice(0, 250);
}

function chunkString(s, max) {
  if (s.length <= max) return [s];
  const out = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + max));
    i += max;
  }
  return out;
}

function safeWrapRange(textNode, start, end, className) {
  const full = textNode.nodeValue;
  const before = full.slice(0, start);
  const mid    = full.slice(start, end);
  const after  = full.slice(end);

  const span = document.createElement("span");
  span.className = className;
  span.textContent = mid;

  const parent = textNode.parentNode;
  const frag = document.createDocumentFragment();
  if (before) frag.appendChild(document.createTextNode(before));
  frag.appendChild(span);
  if (after) frag.appendChild(document.createTextNode(after));
  parent.replaceChild(frag, textNode);
  return span;
}

function attachTooltip(span, verdict, reason, sources) {
  let tip = null;
  function show() {
    tip = document.createElement("div");
    tip.className = "hg-tip";
    const links = (sources || []).slice(0,3).map(s => `<div><a href="${s.url}" target="_blank" rel="noreferrer" style="color:#93c5ff; text-decoration:underline;">${escapeHTML(s.title||s.url)}</a></div>`).join("");
    tip.innerHTML = `<div style="font-weight:800; margin-bottom:4px;">${verdict}</div><div style="opacity:.9">${escapeHTML(reason || "No details")}</div>${links?`<div style="margin-top:6px;">${links}</div>`:""}`;
    document.documentElement.appendChild(tip);
    const rect = span.getBoundingClientRect();
    tip.style.left = `${window.scrollX + rect.left}px`;
    tip.style.top  = `${window.scrollY + rect.bottom + 6}px`;
  }
  function hide() { if (tip && tip.parentNode) tip.parentNode.removeChild(tip); tip = null; }
  span.addEventListener("mouseenter", show);
  span.addEventListener("mouseleave", hide);
}
