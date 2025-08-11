// background.js
const API = "http://192.168.1.6:8000/check";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ hgEnabled: false, autoCheck: true });
  chrome.contextMenus.create({
    id: "hg-check-selection",
    title: "Check health claim",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "hg-check-selection" && info.selectionText && tab?.id) {
    checkClaim(info.selectionText)
      .then(data => chrome.tabs.sendMessage(tab.id, { type: "SHOW_INLINE_RESULT", payload: data }))
      .catch(() => chrome.tabs.sendMessage(tab.id, { type: "SHOW_TOAST", payload: { text: "Error checking claim" } }));
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  const { hgEnabled = false } = await chrome.storage.sync.get("hgEnabled");
  const next = !hgEnabled;
  await chrome.storage.sync.set({ hgEnabled: next });
  await chrome.action.setBadgeBackgroundColor({ color: next ? "#10b981" : "#777" });
  await chrome.action.setBadgeText({ text: next ? "ON" : "" });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "HG_TOGGLED", payload: { enabled: next } });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CHECK_TEXT") {
    (async () => {
      try {
        const data = await checkClaim(msg.text);
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // keep channel open
  } else if (msg.type === "GET_ENABLED") {
    (async () => {
      const { hgEnabled = false, autoCheck = true } = await chrome.storage.sync.get(["hgEnabled","autoCheck"]);
      sendResponse({ ok: true, enabled: hgEnabled, autoCheck });
    })();
    return true;
  }
});

async function checkClaim(text) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!r.ok) throw new Error("Bad response");
  return await r.json();
}
