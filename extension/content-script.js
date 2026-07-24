// Smart Chat — content script.
// Injected on demand (via chrome.scripting.executeScript) only when the user
// triggers a capture from the side panel. Reads the current text selection
// on the page and reports it back over chrome.runtime messaging.
//
// Guarded against being injected more than once into the same page.
if (!window.__smartChatContentScriptInjected) {
  window.__smartChatContentScriptInjected = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "GET_SELECTION") {
      const selection = window.getSelection ? window.getSelection().toString() : "";
      sendResponse({ selection });
    }
    return false;
  });
}
