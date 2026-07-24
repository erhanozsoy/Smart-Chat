require("dotenv").config();

const path = require("path");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const CLAUDE_MODEL = "claude-sonnet-5";
const ALLOWED_TONES = new Set(["warm", "professional", "short"]);
const MAX_CONVERSATION_LENGTH = 8000;
const MAX_INSTRUCTION_LENGTH = 500;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set. Create a .env file (see .env.example) and add your API key before starting the server.",
  );
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TONE_INSTRUCTIONS = {
  warm: "Use a warm, friendly, and approachable tone.",
  professional: "Use a clear, professional, and courteous tone.",
  short: "Keep the reply very brief and to the point — a sentence or two at most.",
};

function buildSystemPrompt(tone) {
  return [
    "You are Smart Chat, an assistant that suggests a reply to a conversation the user pastes in.",
    "Read the conversation and write a single suggested reply the user could send next.",
    TONE_INSTRUCTIONS[tone],
    "Respond with only the reply text itself — no preamble, no explanation, no quotation marks.",
  ].join(" ");
}

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(express.static(__dirname));

app.post("/api/suggest-reply", async (req, res) => {
  const { conversation, instruction, tone } = req.body ?? {};

  if (typeof conversation !== "string" || conversation.trim().length === 0) {
    return res.status(400).json({ error: "Please provide a conversation to reply to." });
  }
  if (conversation.length > MAX_CONVERSATION_LENGTH) {
    return res.status(400).json({ error: "Conversation is too long." });
  }
  if (instruction !== undefined && instruction !== null) {
    if (typeof instruction !== "string" || instruction.length > MAX_INSTRUCTION_LENGTH) {
      return res.status(400).json({ error: "Instruction is invalid or too long." });
    }
  }
  if (!ALLOWED_TONES.has(tone)) {
    return res.status(400).json({ error: "Invalid tone." });
  }

  const userContentParts = [`Conversation:\n${conversation.trim()}`];
  if (instruction && instruction.trim().length > 0) {
    userContentParts.push(`Additional instruction: ${instruction.trim()}`);
  }

  try {
    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      system: buildSystemPrompt(tone),
      messages: [{ role: "user", content: userContentParts.join("\n\n") }],
    });

    const textBlock = message.content.find((block) => block.type === "text");
    const reply = textBlock?.text?.trim();

    if (!reply) {
      console.error("Claude returned no usable text content:", JSON.stringify(message.content));
      return res.status(502).json({ error: "Something went wrong. Please try again." });
    }

    return res.json({ reply });
  } catch (err) {
    console.error("Anthropic API request failed:", err);
    return res.status(502).json({ error: "Something went wrong. Please try again." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Smart Chat server running on http://localhost:${PORT}`);
});
