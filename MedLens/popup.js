// popup.js
const API_BASE  = "http://172.20.10.3:8000/check";
const API_IMAGE = "http://172.20.10.3:8000/check_image";

const claimEl    = document.getElementById("claimInput");
const btn        = document.getElementById("checkBtn");
const result     = document.getElementById("result");
const badge      = document.getElementById("badge");
const reasonEl   = document.getElementById("reason");
const sourcesEl  = document.getElementById("sources");
const enabledTgl = document.getElementById("enabledToggle");
const autoTgl    = document.getElementById("autoToggle");
const testBtn    = document.getElementById("testInline");

const dropArea   = document.getElementById("dropArea");
const dropHint   = document.getElementById("dropHint");
const imgPrev    = document.getElementById("imgPreview");
const captureBtn = document.getElementById("captureBtn");
const ocrEl      = document.getElementById("ocrText");

// NEW: page-scan buttons
const scanBtn    = document.getElementById("scanPageBtn");
const clearBtn   = document.getElementById("clearHighlightsBtn");

// ===== Helpers you already had =====
function setBadge(v) {
  const cls = (v || "uncertain").toLowerCase();
  badge.className = `badge ${cls}`;
  badge.textContent = (cls || "uncertain").toUpperCase();
}

async function checkClaim(text) {
  const r = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!r.ok) throw new Error("Bad response");
  return await r.json();
}

async function checkImage(dataUrl) {
  const r = await fetch(API_IMAGE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl })
  });
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const msg = (data && (data.error || data.reason)) || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

function renderResult(data) {
  setBadge(data.verdict);
  reasonEl.textContent = data.reason || "";
  sourcesEl.innerHTML = (data.sources || [])
    .map(s => `<a href="${s.url}" target="_blank" rel="noreferrer">${(s.title || s.url)}</a>`)
    .join("");
  if (ocrEl) ocrEl.textContent = data.ocr_text || "";
  result.classList.remove("hidden");
}

document.addEventListener("DOMContentLoaded", async () => {
  const cfg = await chrome.storage.sync.get(["hgEnabled", "autoCheck"]);
  enabledTgl.checked = !!cfg.hgEnabled;
  autoTgl.checked = cfg.autoCheck !== false;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const [{ result: sel }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (window.getSelection?.().toString() || "").trim()
      });
      if (sel) claimEl.value = sel;
    }
  } catch {}
});

enabledTgl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ hgEnabled: enabledTgl.checked });
  await chrome.action.setBadgeBackgroundColor({ color: enabledTgl.checked ? "#10b981" : "#777" });
  await chrome.action.setBadgeText({ text: enabledTgl.checked ? "ON" : "" });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "HG_TOGGLED", payload: { enabled: enabledTgl.checked } });
});

autoTgl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ autoCheck: autoTgl.checked });
});

btn.addEventListener("click", async () => {
  const text = (claimEl.value || "").trim();
  if (!text) return;
  btn.disabled = true;
  btn.textContent = "Checking…";
  result.classList.add("hidden");
  try {
    const data = await checkClaim(text);
    renderResult(data);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "SHOW_INLINE_RESULT", payload: data });
  } catch (e) {
    setBadge("uncertain");
    reasonEl.textContent = String(e?.message || "Could not verify right now. Try again.");
    sourcesEl.innerHTML = "";
    if (ocrEl) ocrEl.textContent = "";
    result.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Check claim";
  }
});

testBtn.addEventListener("click", async () => {
  const fake = {
    verdict: "misleading",
    reason: "Example inline test bubble.",
    sources: [{ title: "WHO", url: "https://www.who.int" }]
  };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "SHOW_INLINE_RESULT", payload: fake });
});

/* Drag & Drop / Paste handling */
["dragenter", "dragover"].forEach(evt => {
  dropArea.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropArea.style.borderColor = "#60a5fa";
    dropArea.style.background = "#f0f7ff";
  });
});
["dragleave", "drop"].forEach(evt => {
  dropArea.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropArea.style.borderColor = "#cfcfcf";
    dropArea.style.background = "#fafafa";
  });
});

dropArea.addEventListener("drop", async (e) => {
  const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith("image/"));
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => runImageFlow(reader.result);
  reader.readAsDataURL(f);
});

dropArea.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      const reader = new FileReader();
      reader.onload = () => runImageFlow(reader.result);
      reader.readAsDataURL(f);
      e.preventDefault();
      return;
    }
  }
});

async function runImageFlow(dataUrl) {
  imgPrev.src = dataUrl;
  imgPrev.classList.remove("hidden");
  dropHint.classList.add("hidden");

  setBadge("uncertain");
  reasonEl.textContent = "Checking image…";
  sourcesEl.innerHTML = "";
  if (ocrEl) ocrEl.textContent = "";
  result.classList.remove("hidden");

  try {
    const data = await checkImage(dataUrl);
    renderResult(data);
  } catch (e) {
    setBadge("uncertain");
    reasonEl.textContent = String(e?.message || "Image check failed. Try again.");
    sourcesEl.innerHTML = "";
    if (ocrEl) ocrEl.textContent = "";
  }
}

/* Start Region Capture on Page */
captureBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: "START_REGION_CAPTURE" });
      window.close();
    }
  } catch (e) { console.error(e); }
});

/* ===== NEW: wire scan/clear buttons ===== */
scanBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "SCAN_PAGE" });
});
clearBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "CLEAR_HIGHLIGHTS" });
});

/* ============================
   Voice (mic + TTS via background proxy)
   ============================ */
const voiceInput   = document.getElementById("voiceInput");
const voiceMic     = document.getElementById("voiceMic");
const voiceAsk     = document.getElementById("voiceAsk");
const voiceResult  = document.getElementById("voiceResult");
const voiceBadge   = document.getElementById("voiceBadge");
const voiceReason  = document.getElementById("voiceReason");
const voiceSources = document.getElementById("voiceSources");
const voiceAudio   = document.getElementById("voiceAudio");

function vSetBadge(v) {
  const cls = (v || "uncertain").toLowerCase();
  voiceBadge.className = `badge ${cls}`;
  voiceBadge.textContent = (cls || "uncertain").toUpperCase();
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// ask -> CHECK_TEXT -> play TTS (via background)
async function voiceSubmit() {
  const text = (voiceInput.value || "").trim();
  if (!text) return;

  voiceAsk.disabled = true;
  const prev = voiceAsk.textContent; voiceAsk.textContent = "Checking…";
  voiceResult.classList.remove("hidden");
  vSetBadge("uncertain");
  voiceReason.textContent = "";
  voiceSources.innerHTML = "";
  try {
    const data = await checkClaim(text);
    const verdict = (data.verdict || "uncertain").toLowerCase();
    vSetBadge(verdict);
    voiceReason.textContent = data.reason || "";
    voiceSources.innerHTML = (data.sources || []).map(s => `<a href="${s.url}" target="_blank" rel="noreferrer">${escapeHTML(s.title || s.url)}</a>`).join("");

    const utterText = `${voiceBadge.textContent}. ${data.reason || ""}`;
    const ttsResp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "TTS_SWARA", text: utterText, voice: "hi-IN-SwaraNeural" }, resolve);
    });
    if (ttsResp?.ok && ttsResp.audioUrl) {
      voiceAudio.src = ttsResp.audioUrl;
      try { await voiceAudio.play(); } catch {}
    } else if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(utterText);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    }
  } catch (e) {
    vSetBadge("uncertain");
    voiceReason.textContent = String(e?.message || "Could not verify right now.");
    voiceSources.innerHTML = "";
  } finally {
    voiceAsk.disabled = false;
    voiceAsk.textContent = prev;
  }
}

voiceAsk.addEventListener("click", voiceSubmit);

// Mic (Web Speech API)
let recog = null, listening = false;
const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;

function setMic(on) {
  listening = on;
  voiceMic.textContent = on ? "⏹" : "🎤";
  voiceMic.title = on ? "Stop" : "Speak";
}

voiceMic.addEventListener("click", () => {
  if (!Ctor) { alert("Use Chrome/Edge for mic"); return; }
  if (listening) { try { recog.stop(); } catch {} return; }

  recog = new Ctor();
  recog.lang = navigator.language || "en-IN";
  recog.interimResults = true; recog.continuous = true; recog.maxAlternatives = 1;

  setMic(true);

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
    voiceInput.value = combined;
  };
  recog.onerror = () => { try { recog.stop(); } catch {} };
  recog.onend = () => { setMic(false); voiceSubmit(); };

  try { recog.start(); } catch {}
});
