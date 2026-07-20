// Canned reply variants per tone, used by script.js in place of a real API call.
const MOCK_REPLIES = {
  warm: [
    "Thanks so much for reaching out! I really appreciate you taking the time to message me. Let me know if there's anything else I can help with. 😊",
    "Hey! Great to hear from you. I'd be happy to help with this — just let me know what works best for you.",
    "Thank you for your patience! I wanted to check in and make sure everything's going smoothly on your end.",
  ],
  professional: [
    "Thank you for your message. I have reviewed the details and will follow up with the requested information shortly.",
    "I appreciate you bringing this to my attention. Please let me know if you need any further clarification.",
    "Thank you for reaching out. I can confirm the details and will proceed accordingly unless you advise otherwise.",
  ],
  short: [
    "Got it, thanks!",
    "Sounds good — I'll follow up soon.",
    "Understood, thank you.",
  ],
};

const TONES = ["warm", "professional", "short"];
