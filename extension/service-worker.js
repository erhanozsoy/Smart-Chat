// Smart Chat — background service worker (Manifest V3).
//
// The critical piece: text selection is captured the moment the toolbar
// icon is clicked (chrome.action.onClicked), because that click is the
// user gesture that grants `activeTab` for the tab. Waiting until the side
// panel has opened and asks for it is too late/unreliable — by then the
// gesture may no longer cover a fresh capture, and the service worker may
// have been torn down and restarted by Chrome (MV3 service workers are
// not persistent), silently losing anything kept only in a JS variable.
// So the captured text is stored in chrome.storage.session, which survives
// service worker restarts for the life of the browser session.
//
// IMPORTANT: chrome.sidePanel.setPanelBehavior({openPanelOnActionClick})
// is persisted by Chrome *per extension*, independently of this file's
// contents — it survives "Reload" on chrome://extensions and service
// worker restarts. An earlier version of this extension set it to `true`.
// If that setting is still in effect, chrome.action.onClicked below NEVER
// fires (the two are mutually exclusive), which silently breaks the entire
// capture flow with no error anywhere. So it is explicitly forced back to
// `false` unconditionally, every time this script runs — not just in
// onInstalled — since onInstalled/onStartup don't cover every case a
// service worker script can (re)start (e.g. woken by a message).

const DEBUG_PREFIX = "[Smart Chat]";

function resetPanelBehavior(source) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((err) => {
      console.error(DEBUG_PREFIX, `failed to reset panel behavior (${source}):`, err);
    });
}

// Runs unconditionally as soon as this script is evaluated, regardless of
// why the service worker started.
resetPanelBehavior("module load");

chrome.runtime.onInstalled.addListener(() => resetPanelBehavior("onInstalled"));
chrome.runtime.onStartup.addListener(() => resetPanelBehavior("onStartup"));

const RESTRICTED_URL_PATTERNS = [
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^chrome-error:\/\//i,
  /^edge:\/\//i,
  /^about:/i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/chromewebstore\.google\.com/i,
  /^https:\/\/microsoftedge\.microsoft\.com\/addons/i,
];

function isRestrictedUrl(url) {
  // If we can't see the URL at all (e.g. the panel was opened without ever
  // going through a toolbar click, so activeTab was never granted), don't
  // guess — let the actual scripting attempt below decide and report that
  // as a scripting error instead of a false "restricted page" message.
  if (!url) return false;
  return RESTRICTED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

// In-memory cache for same-lifetime speed; chrome.storage.session is the
// real source of truth (see comment above).
let lastCapturedConversation = null;

// The tab the extension should read from — set unambiguously from
// chrome.action.onClicked's own tab argument (no query involved), and
// reused for later captures in the same panel session. See getTargetTab().
let currentTargetTabId = null;

async function rememberTargetTab(tabId) {
  currentTargetTabId = tabId;
  try {
    await chrome.storage.session.set({ smartChatTargetTabId: tabId });
  } catch (err) {
    console.error(DEBUG_PREFIX, "failed to persist target tab id:", err);
  }
}

async function restoreTargetTabId() {
  if (typeof currentTargetTabId === "number") return;
  try {
    const data = await chrome.storage.session.get("smartChatTargetTabId");
    if (typeof data.smartChatTargetTabId === "number") {
      currentTargetTabId = data.smartChatTargetTabId;
    }
  } catch (err) {
    console.error(DEBUG_PREFIX, "failed to restore target tab id:", err);
  }
}

async function getTargetTab() {
  await restoreTargetTabId();

  if (typeof currentTargetTabId === "number") {
    try {
      return await chrome.tabs.get(currentTargetTabId);
    } catch (err) {
      // The tracked tab was closed or no longer exists — fall through to a
      // fresh query below (this is the "no click-time capture yet" path,
      // e.g. the panel was opened via Chrome's own side panel picker).
      currentTargetTabId = null;
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && typeof tab.id === "number") {
    currentTargetTabId = tab.id;
  }
  return tab;
}

async function readSelectionFromTab(tabId) {
  // Primary method: inject a small inline function directly and read its
  // result. This is a single round trip (no separate "inject the file, then
  // hope a listener is ready to receive a message" race), it re-runs fresh
  // every time rather than depending on a previously-injected listener
  // surviving (which breaks after an extension reload until the page is
  // refreshed), and allFrames also picks up selections made inside
  // same-origin iframes.
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        try {
          return window.getSelection ? window.getSelection().toString() : "";
        } catch (err) {
          return "";
        }
      },
    });
    const found = (results || [])
      .map((frameResult) => (typeof frameResult.result === "string" ? frameResult.result.trim() : ""))
      .find((text) => text.length > 0);
    return { ok: true, selection: found || "" };
  } catch (err) {
    console.error(DEBUG_PREFIX, "direct selection read failed, trying content-script fallback:", err);
  }

  // Fallback: inject content-script.js (top frame only) and message it.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    const response = await chrome.tabs.sendMessage(tabId, { type: "GET_SELECTION" });
    return { ok: true, selection: (response?.selection ?? "").trim() };
  } catch (err) {
    console.error(DEBUG_PREFIX, "content-script fallback capture failed:", err);
    return { ok: false };
  }
}

async function captureFromTab(tab) {
  if (!tab || typeof tab.id !== "number") {
    return { ok: false, errorType: "no-tab" };
  }
  if (isRestrictedUrl(tab.url)) {
    return { ok: false, errorType: "restricted" };
  }

  const result = await readSelectionFromTab(tab.id);
  if (!result.ok) {
    return { ok: false, errorType: "scripting" };
  }
  if (!result.selection) {
    return { ok: false, errorType: "empty" };
  }
  return { ok: true, selection: result.selection };
}

async function captureAndStore(tab) {
  const result = await captureFromTab(tab);

  if (result.ok) {
    // Only overwrite the stored conversation on a new *successful* capture,
    // so a transient failure (e.g. briefly focusing a restricted tab)
    // doesn't wipe out the last good selection.
    lastCapturedConversation = result.selection;
    try {
      await chrome.storage.session.set({ smartChatLastCapture: result.selection });
    } catch (err) {
      console.error(DEBUG_PREFIX, "failed to persist capture to storage.session:", err);
    }

    // Push the fresh result to any side panel that's already open and
    // listening, so a panel that asked too early (before this capture
    // finished) still gets updated instead of being stuck on an empty
    // field until the user manually retries.
    chrome.runtime.sendMessage({ type: "CAPTURE_UPDATED", selection: result.selection }).catch(() => {
      // No listener currently open — expected when nothing is listening yet.
    });
  }

  return result;
}

chrome.action.onClicked.addListener((tab) => {
  // chrome.sidePanel.open() must be called synchronously in response to the
  // click (no await before it), or Chrome can reject it as not being a
  // direct user gesture — so this goes first, uninterrupted.
  chrome.sidePanel.open({ tabId: tab.id }).catch((err) => {
    console.error(DEBUG_PREFIX, "failed to open side panel:", err);
  });

  // This click is what grants activeTab for the tab, so capture the
  // current selection right now instead of waiting for the side panel to
  // ask for it later, by which point the moment may have passed.
  rememberTargetTab(tab.id);
  captureAndStore(tab).catch((err) => {
    console.error(DEBUG_PREFIX, "capture-on-click failed:", err);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_LAST_CAPTURE") {
    if (lastCapturedConversation) {
      sendResponse({ selection: lastCapturedConversation });
      return false;
    }
    chrome.storage.session
      .get("smartChatLastCapture")
      .then((data) => sendResponse({ selection: data.smartChatLastCapture || "" }))
      .catch((err) => {
        console.error(DEBUG_PREFIX, "failed to read storage.session:", err);
        sendResponse({ selection: "" });
      });
    return true; // async response
  }

  if (message?.type === "CAPTURE_CONVERSATION") {
    (async () => {
      try {
        // Always resolved here in the service worker (see getTargetTab's
        // comment) — the side panel no longer queries tabs itself.
        const tab = await getTargetTab();
        const result = await captureAndStore(tab);
        sendResponse(result);
      } catch (err) {
        console.error(DEBUG_PREFIX, "CAPTURE_CONVERSATION handler failed:", err);
        sendResponse({ ok: false, errorType: "scripting" });
      }
    })();
    return true; // async response
  }

  return false;
});
