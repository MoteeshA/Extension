// popup.js
const API_BASE = "http://192.168.1.6:8000/check";

const claimEl    = document.getElementById("claimInput");
const btn        = document.getElementById("checkBtn");
const result     = document.getElementById("result");
const badge      = document.getElementById("badge");
const reasonEl   = document.getElementById("reason");
const sourcesEl  = document.getElementById("sources");
const enabledTgl = document.getElementById("enabledToggle");
const autoTgl    = document.getElementById("autoToggle");
const testBtn    = document.getElementById("testInline");
const captureBtn = document.getElementById("captureBtn"); // NEW

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

document.addEventListener("DOMContentLoaded", async () => {
  const cfg = await chrome.storage.sync.get(["hgEnabled", "autoCheck"]);
  enabledTgl.checked = !!cfg.hgEnabled;
  autoTgl.checked = cfg.autoCheck !== false;

  // preload selected text from page (best-effort)
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
    setBadge(data.verdict);
    reasonEl.textContent = data.reason || "";
    sourcesEl.innerHTML = (data.sources || [])
      .map(s => `<a href="${s.url}" target="_blank" rel="noreferrer">${s.title || s.url}</a>`)
      .join("");
    result.classList.remove("hidden");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "SHOW_INLINE_RESULT", payload: data });
  } catch (e) {
    setBadge("uncertain");
    reasonEl.textContent = "Could not verify right now. Try again.";
    sourcesEl.innerHTML = "";
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

// NEW: start region capture in the active tab
captureBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: "START_REGION_CAPTURE" });
      window.close(); // let the user drag immediately
    }
  } catch (e) { console.error(e); }
});
