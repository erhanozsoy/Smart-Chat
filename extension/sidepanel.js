// Smart Chat — side panel logic.
// Talks to the local Smart Chat backend only (never to the Claude API directly).
const BACKEND_URL = "http://localhost:3000";
const ALLOWED_TONES = ["warm", "professional", "short"];
const DEFAULT_TONE = "professional";
const SELECT_TEXT_MESSAGE =
  "Select the recent conversation on the page, then click Capture Conversation.";
const SERVER_DOWN_MESSAGE = "Smart Chat server is not running. Start the local server and try again.";

// Mirrors the errorType values returned by service-worker.js, so capture
// failures are reported with the right message instead of a generic one.
const CAPTURE_ERROR_MESSAGES = {
  restricted: "Chrome does not allow extensions to read this page. Try a regular website.",
  empty: "No text is selected. Select the recent conversation on the page, then try again.",
  scripting: "Smart Chat could not capture the selected text. Reload the extension and the webpage, then try again.",
  "no-tab": "No active tab found. Open a webpage and try again.",
};

function captureErrorMessage(errorType) {
  return CAPTURE_ERROR_MESSAGES[errorType] || CAPTURE_ERROR_MESSAGES.scripting;
}

const THEME_STORAGE_KEY = "smartChatTheme";
const ALLOWED_THEMES = ["light", "dark"];

const conversationEl = document.getElementById("conversation");
const instructionEl = document.getElementById("instruction");
const toneButtons = Array.from(document.querySelectorAll(".tone-option"));
const themeButtons = Array.from(document.querySelectorAll(".theme-option"));
const captureBtn = document.getElementById("capture-btn");
const suggestBtn = document.getElementById("suggest-btn");
const loadingState = document.getElementById("loading-state");
const errorState = document.getElementById("error-state");
const errorMessage = document.getElementById("error-message");
const resultState = document.getElementById("result-state");
const resultEl = document.getElementById("result");
const copyBtn = document.getElementById("copy-btn");
const anotherBtn = document.getElementById("another-btn");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");

let selectedTone = DEFAULT_TONE;
let suggestionInFlight = false;
let captureInFlight = false;
let themeIsExplicit = false;

function setTone(tone, { persist = true } = {}) {
  selectedTone = tone;
  toneButtons.forEach((btn) => {
    const isActive = btn.dataset.tone === tone;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-checked", String(isActive));
  });
  if (persist) {
    chrome.storage.local.set({ smartChatTone: tone });
  }
}

// Applies a theme instantly (no reload needed) by setting a single
// attribute — sidepanel.css keys its color variables off
// documentElement[data-theme="light"|"dark"].
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeButtons.forEach((btn) => {
    const isActive = btn.dataset.themeChoice === theme;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

function setTheme(theme, { persist = true } = {}) {
  applyTheme(theme);
  if (persist) {
    themeIsExplicit = true;
    chrome.storage.local.set({ [THEME_STORAGE_KEY]: theme }).catch((err) => {
      console.error("Smart Chat: failed to save theme preference:", err);
    });
  }
}

function systemTheme() {
  // If the platform can't report a preference, keep the original hardcoded
  // dark look this panel shipped with, rather than defaulting to light.
  if (!window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

async function initTheme() {
  try {
    const data = await chrome.storage.local.get(THEME_STORAGE_KEY);
    if (ALLOWED_THEMES.includes(data[THEME_STORAGE_KEY])) {
      themeIsExplicit = true;
      applyTheme(data[THEME_STORAGE_KEY]);
      return;
    }
  } catch (err) {
    console.error("Smart Chat: failed to load theme preference:", err);
  }
  // No stored preference yet — follow the system theme, and keep following
  // it live (see the matchMedia listener below) until the user explicitly
  // picks one.
  applyTheme(systemTheme());
}

if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!themeIsExplicit) applyTheme(systemTheme());
  });
}

themeButtons.forEach((btn) => {
  btn.addEventListener("click", () => setTheme(btn.dataset.themeChoice));
});

function hideAllStates() {
  loadingState.classList.add("hidden");
  errorState.classList.add("hidden");
  resultState.classList.add("hidden");
}

function showLoading() {
  hideAllStates();
  loadingState.classList.remove("hidden");
  setButtonsDisabled(true);
}

function showError(message) {
  hideAllStates();
  errorMessage.textContent = message;
  errorState.classList.remove("hidden");
  setButtonsDisabled(false);
}

function showResult(text) {
  hideAllStates();
  resultEl.value = text;
  resultState.classList.remove("hidden");
  setButtonsDisabled(false);
}

function setButtonsDisabled(disabled) {
  suggestBtn.disabled = disabled;
  anotherBtn.disabled = disabled;
}

function setStatus(state, text) {
  statusEl.classList.remove("online", "offline");
  if (state) statusEl.classList.add(state);
  statusTextEl.textContent = text;
}

async function checkServerStatus() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${BACKEND_URL}/api/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      setStatus("online", "Server connected");
    } else {
      setStatus("offline", "Server unavailable");
    }
  } catch (err) {
    setStatus("offline", "Server offline");
  }
}

async function captureConversation() {
  if (captureInFlight) return;
  captureInFlight = true;
  captureBtn.disabled = true;
  hideAllStates();

  try {
    // Deliberately no chrome.tabs.query() here — tested against real
    // Chrome, querying "the active tab" from inside the side panel itself
    // is unreliable (the panel can be misidentified as part of the active
    // window state). The service worker resolves the correct tab instead,
    // using the tab it captured directly from the toolbar-icon click event.
    const response = await chrome.runtime.sendMessage({ type: "CAPTURE_CONVERSATION" });

    if (!response || !response.ok) {
      showError(captureErrorMessage(response?.errorType));
      return;
    }

    conversationEl.value = response.selection;
    hideAllStates();
  } catch (err) {
    console.error("Smart Chat: capture failed:", err);
    showError(captureErrorMessage("scripting"));
  } finally {
    captureInFlight = false;
    captureBtn.disabled = false;
  }
}

async function loadInitialConversation() {
  try {
    // The service worker captures the selection at the moment the toolbar
    // icon was clicked (before this panel even finished loading) and
    // stashes it — read that first. If the click-time capture hasn't
    // finished yet, the CAPTURE_UPDATED listener above will catch it when
    // it does; this isn't the only chance to populate the field.
    const response = await chrome.runtime.sendMessage({ type: "GET_LAST_CAPTURE" });
    if (response?.selection) {
      conversationEl.value = response.selection;
      return;
    }
  } catch (err) {
    console.error("Smart Chat: failed to load last capture:", err);
  }
  // Nothing stashed yet — e.g. the panel was opened via Chrome's own side
  // panel picker instead of the toolbar icon. Fall back to a live capture.
  await captureConversation();
}

async function requestSuggestion() {
  if (suggestionInFlight) return;

  const conversation = conversationEl.value.trim();
  if (!conversation) {
    showError(SELECT_TEXT_MESSAGE);
    return;
  }

  suggestionInFlight = true;
  showLoading();

  try {
    const response = await fetch(`${BACKEND_URL}/api/suggest-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recentConversation: conversation,
        additionalInstruction: instructionEl.value.trim(),
        tone: selectedTone,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.reply) {
      showError(data.error || "Something went wrong. Please try again.");
      return;
    }

    showResult(data.reply);
  } catch (err) {
    showError(SERVER_DOWN_MESSAGE);
  } finally {
    suggestionInFlight = false;
  }
}

captureBtn.addEventListener("click", captureConversation);

suggestBtn.addEventListener("click", requestSuggestion);

anotherBtn.addEventListener("click", requestSuggestion);

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(resultEl.value);
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied";
    copyBtn.classList.add("copied"); // styling only — see .btn-utility.copied in sidepanel.css
    setTimeout(() => {
      copyBtn.textContent = original;
      copyBtn.classList.remove("copied");
    }, 1500);
  } catch (err) {
    showError("Couldn't copy to clipboard. Please copy manually.");
  }
});

toneButtons.forEach((btn) => {
  btn.addEventListener("click", () => setTone(btn.dataset.tone));
});

// Live update channel: the service worker pushes CAPTURE_UPDATED whenever a
// capture completes (from either the click-time capture or the Capture
// Conversation button). This closes the race where the panel's initial
// GET_LAST_CAPTURE fires before the click-time capture has finished — the
// panel doesn't just ask once and give up, it also stays listening.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CAPTURE_UPDATED" && typeof message.selection === "string") {
    conversationEl.value = message.selection;
    hideAllStates();
  }
});

// Initialize: apply the saved/system theme, restore last-used tone, check
// server status, and load the conversation the service worker captured
// when the toolbar icon was clicked (see loadInitialConversation for the
// fallback path).
initTheme();

chrome.storage.local
  .get("smartChatTone")
  .then((data) => {
    const tone = ALLOWED_TONES.includes(data.smartChatTone) ? data.smartChatTone : DEFAULT_TONE;
    setTone(tone, { persist: false });
  })
  .catch((err) => {
    console.error("Smart Chat: failed to load saved tone:", err);
    setTone(DEFAULT_TONE, { persist: false });
  });

checkServerStatus();
loadInitialConversation();
