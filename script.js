// Phase 1 prototype: all "replies" are mocked (see mock-data.js). No network calls.

const conversationEl = document.getElementById("conversation");
const instructionEl = document.getElementById("instruction");
const toneButtons = Array.from(document.querySelectorAll(".tone-option"));
const suggestBtn = document.getElementById("suggest-btn");
const loadingState = document.getElementById("loading-state");
const errorState = document.getElementById("error-state");
const errorMessage = document.getElementById("error-message");
const errorRetryBtn = document.getElementById("error-retry-btn");
const resultState = document.getElementById("result-state");
const resultEl = document.getElementById("result");
const copyBtn = document.getElementById("copy-btn");
const anotherBtn = document.getElementById("another-btn");
const forceErrorBtn = document.getElementById("force-error-btn");

const SIMULATED_DELAY_MS = 1000;

let selectedTone = "professional";
let replyIndex = 0;
let forceErrorNext = false;

function setTone(tone) {
  selectedTone = tone;
  replyIndex = 0;
  toneButtons.forEach((btn) => {
    const isActive = btn.dataset.tone === tone;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-checked", String(isActive));
  });
}

function showLoading() {
  hideAllStates();
  loadingState.classList.remove("hidden");
  suggestBtn.disabled = true;
  anotherBtn.disabled = true;
}

function showError(message) {
  hideAllStates();
  errorMessage.textContent = message;
  errorState.classList.remove("hidden");
  suggestBtn.disabled = false;
}

function showResult(text) {
  hideAllStates();
  resultEl.value = text;
  resultState.classList.remove("hidden");
  suggestBtn.disabled = false;
  anotherBtn.disabled = false;
}

function hideAllStates() {
  loadingState.classList.add("hidden");
  errorState.classList.add("hidden");
  // Result stays visible across "Another Reply" regenerations, so it is only
  // hidden explicitly when a fresh result or error is about to replace it.
  resultState.classList.add("hidden");
}

function nextMockReply() {
  const replies = MOCK_REPLIES[selectedTone];
  const reply = replies[replyIndex % replies.length];
  replyIndex += 1;

  const instruction = instructionEl.value.trim();
  return instruction ? `${reply}\n\n(Instruction noted: "${instruction}" — full support arrives in Phase 2.)` : reply;
}

function requestSuggestion() {
  if (forceErrorNext) {
    forceErrorNext = false;
    showLoading();
    setTimeout(() => {
      showError("Something went wrong. Please try again.");
    }, SIMULATED_DELAY_MS);
    return;
  }

  showLoading();
  setTimeout(() => {
    showResult(nextMockReply());
  }, SIMULATED_DELAY_MS);
}

suggestBtn.addEventListener("click", () => {
  if (!conversationEl.value.trim()) {
    showError("Please paste a conversation first.");
    return;
  }
  replyIndex = 0;
  requestSuggestion();
});

anotherBtn.addEventListener("click", () => {
  requestSuggestion();
});

errorRetryBtn.addEventListener("click", () => {
  hideAllStates();
  if (conversationEl.value.trim()) {
    requestSuggestion();
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(resultEl.value);
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    setTimeout(() => {
      copyBtn.textContent = original;
    }, 1500);
  } catch (err) {
    showError("Couldn't copy to clipboard. Please copy manually.");
  }
});

toneButtons.forEach((btn) => {
  btn.addEventListener("click", () => setTone(btn.dataset.tone));
});

// Dev-only hook to visually review the error state; remove in Phase 2.
if (forceErrorBtn) {
  forceErrorBtn.addEventListener("click", () => {
    forceErrorNext = true;
    if (!conversationEl.value.trim()) {
      conversationEl.value = "Hi, is this item still available?";
    }
    requestSuggestion();
  });
}

if (new URLSearchParams(window.location.search).has("forceError")) {
  forceErrorNext = true;
}
