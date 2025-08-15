// background.js
const API_BASE  = "http://172.20.10.3:8000/check";
const API_IMAGE = "http://172.20.10.3:8000/check_image"; // single host everywhere
// NEW: Swara TTS endpoint
const API_TTS   = "http://172.20.10.3:8000/tts";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ hgEnabled: true, autoCheck: true });
  chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
  chrome.action.setBadgeText({ text: "ON" });
  chrome.contextMenus.create({
    id: "hg-check-selection",
    title: "HealthGuard: Check selection",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "hg-check-selection" && info.selectionText) {
    try {
      const data = await checkText(info.selectionText);
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "SHOW_INLINE_RESULT", payload: data });
    } catch (err) {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, {
        type: "SHOW_INLINE_RESULT",
        payload: { verdict: "uncertain", reason: String(err), sources: [] }
      });
    }
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  const cfg = await chrome.storage.sync.get(["hgEnabled"]);
  const next = !cfg.hgEnabled;
  await chrome.storage.sync.set({ hgEnabled: next });
  await chrome.action.setBadgeBackgroundColor({ color: next ? "#10b981" : "#777" });
  await chrome.action.setBadgeText({ text: next ? "ON" : "OFF" });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "HG_TOGGLED", payload: { enabled: next } });
});

// Core message hub
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "GET_ENABLED") {
        const cfg = await chrome.storage.sync.get(["hgEnabled", "autoCheck"]);
        sendResponse({ ok: true, enabled: !!cfg.hgEnabled, autoCheck: !!cfg.autoCheck });
        return;
      }

      if (msg.type === "CAPTURE_VISIBLE_TAB") {
        chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 90 }, (dataUrl) => {
          if (chrome.runtime.lastError || !dataUrl) {
            sendResponse({ ok: false, error: chrome.runtime.lastError?.message || "capture failed" });
          } else {
            sendResponse({ ok: true, dataUrl });
          }
        });
        return;
      }

      if (msg.type === "CHECK_TEXT") {
        const r = await fetch(API_BASE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: msg.text })
        });
        const data = await safeParseJson(r);
        sendResponse({ ok: r.ok, data, error: !r.ok ? (data?.error || data?.detail || r.statusText) : undefined });
        return;
      }

      // NEW: lightweight batching from content script
      if (msg.type === "CHECK_BATCH") {
        const items = Array.isArray(msg.items) ? msg.items : [];
        const concurrency = Number(msg.concurrency || 3);
        const results = await runWithConcurrency(items, concurrency, async (text) => {
          const r = await fetch(API_BASE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text })
          });
          const data = await safeParseJson(r);
          if (!r.ok) throw new Error(data?.error || r.statusText);
          return data; // { verdict, reason, sources }
        });
        sendResponse({ ok: true, results });
        return;
      }

      // Proxy image check to avoid mixed-content/private network issues
      if (msg.type === "CHECK_IMAGE") {
        const r = await fetch(API_IMAGE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image: msg.image })
        });
        const data = await safeParseJson(r);
        if (!r.ok) {
          console.warn("[HG/bg] CHECK_IMAGE failed", { status: r.status, statusText: r.statusText, data });
        }
        sendResponse({ ok: r.ok, data, error: !r.ok ? (data?.error || data?.detail || r.statusText) : undefined });
        return;
      }

      // NEW: Swara TTS proxy
      if (msg.type === "TTS_SWARA") {
        const text = (msg.text || "").trim();
        const voice = (msg.voice || "hi-IN-SwaraNeural").trim();

        if (!text) {
          sendResponse({ ok: false, error: "No text for TTS" });
          return;
        }

        try {
          const r = await fetch(API_TTS, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, voice })
          });

          if (!r.ok) {
            const errJson = await safeParseJson(r);
            sendResponse({ ok: false, error: errJson?.error || r.statusText });
            return;
          }
          const ct = r.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const errJson = await r.json().catch(() => null);
            sendResponse({ ok: false, error: errJson?.error || "Unexpected JSON from /tts" });
            return;
          }

          const buf = await r.arrayBuffer();
          const dataUrl = arrayBufferToDataURL(buf, "audio/mpeg");
          sendResponse({ ok: true, audioUrl: dataUrl });
        } catch (e) {
          console.error("[HG/bg] TTS_SWARA error:", e);
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
        return;
      }

      sendResponse({ ok: false, error: "unknown message type" });
    } catch (e) {
      console.error("[HG/bg] handler error:", e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // keep channel open for async
});

async function checkText(text) {
  const r = await fetch(API_BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}

// Helper: robust JSON parse with fallback text
async function safeParseJson(r) {
  try {
    return await r.clone().json();
  } catch {
    try {
      const t = await r.clone().text();
      return t ? { error: t } : null;
    } catch {
      return null;
    }
  }
}

// NEW: convert ArrayBuffer -> data URL (base64), safe for large buffers
function arrayBufferToDataURL(buffer, mime = "application/octet-stream") {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  const base64 = btoa(binary);
  return `data:${mime};base64,${base64}`;
}

// NEW: tiny concurrency runner
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    const i = idx++;
    if (i >= items.length) return;
    try {
      results[i] = { ok: true, value: await worker(items[i]) };
    } catch (e) {
      results[i] = { ok: false, error: String(e?.message || e) };
    }
    return next();
  }
  const starters = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(starters);
  return results;
}
