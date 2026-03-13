
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const { chromium } = require("playwright");
const twilio = require("twilio");

const APP_NAME = process.env.APP_NAME || "Derby Bin Bot";
const PORT = parseInt(process.env.PORT || "3000", 10);
const TIMEZONE = process.env.TIMEZONE || "Europe/London";
const DATA_DIR = process.env.DATA_DIR || "/data";
const DATA_FILE = path.join(DATA_DIR, "bot-data.json");
const RUN_KEY = process.env.RUN_KEY || "";
const REMINDER_TIME_TEXT = process.env.REMINDER_TIME_TEXT || "18:00";

if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM) {
  console.error("Missing Twilio configuration.");
  process.exit(1);
}

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

ensureStore();

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: {}, sent: {} }, null, 2));
  }
}

function loadStore() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function normalizeWhatsApp(value) {
  if (!value) return "";
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

function normalizeText(text) {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim()
    .toLowerCase();
}

function titleCase(text) {
  return (text || "").replace(/\b\w/g, c => c.toUpperCase());
}

function getTomorrowText() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: TIMEZONE
  }).toLowerCase();
}

function todayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

function classifyBinType(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("general waste") || t.includes("black bin")) return "general waste";
  if (t.includes("recycling") || t.includes("blue bin")) return "recycling";
  if (t.includes("garden") || t.includes("brown bin")) return "garden waste";
  if (t.includes("food waste")) return "food waste";
  return "unknown";
}

function binLabelAndEmoji(binType) {
  const t = (binType || "").toLowerCase();
  if (t.includes("recycl")) return { label: "Blue bin – Recycling", emoji: "🟦" };
  if (t.includes("garden")) return { label: "Brown bin – Garden waste", emoji: "🟫" };
  if (t.includes("food")) return { label: "Green bin – Food waste", emoji: "🟩" };
  if (t.includes("general") || t.includes("black")) return { label: "Black bin – General waste", emoji: "⬛" };
  return { label: "Bin collection", emoji: "🗑️" };
}

function extractBinCollections(bodyText) {
  const text = normalizeText(bodyText);
  const pattern =
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s+(\d{1,2}\s+[a-z]+\s+\d{4})\s*:\s*([a-z ]+?bin collection)\b/gi;

  const results = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const date = match[1].toLowerCase().trim();
    const description = match[2].toLowerCase().trim();
    results.push({ date, binType: classifyBinType(description), description });
  }

  const seen = new Set();
  return results.filter(item => {
    const key = `${item.date}__${item.binType}__${item.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseQuickSetup(text) {
  const input = (text || "").trim();
  const postcodeRegex = /\b([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i;
  const match = input.match(postcodeRegex);
  if (!match) return null;

  const rawPostcode = match[1].toUpperCase().replace(/\s+/g, "");
  const postcode = rawPostcode.replace(/^(.+)(.{3})$/, "$1 $2");
  let remainder = input.replace(match[0], "").trim();
  remainder = remainder.replace(/^,+/, "").trim();

  if (!remainder) return { postcode, query: "", type: "postcode_only" };
  return { postcode, query: remainder, type: "postcode_plus_query" };
}

function isLikelyNumericQuery(text) {
  return /^\d+[A-Z]?$/.test((text || "").trim().toUpperCase());
}

function propertyMatchesQuery(optionText, query) {
  const option = String(optionText || "").toLowerCase();
  const q = (query || "").trim().toLowerCase();
  if (!q) return false;

  if (isLikelyNumericQuery(q.toUpperCase())) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`\\b${escaped}\\b`, "i"),
      new RegExp(`,\\s*${escaped}\\b`, "i"),
      new RegExp(`\\b${escaped},`, "i")
    ];
    return patterns.some(rx => rx.test(optionText));
  }

  return option.includes(q);
}

async function getAddressOptionsForPostcode(postcode) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    await page.goto("https://secure.derby.gov.uk/binday/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    const cookieBtn = page.locator("#allow-all-cookies");
    if (await cookieBtn.count()) {
      try {
        if (await cookieBtn.isVisible()) {
          await cookieBtn.click();
          await page.waitForTimeout(500);
        }
      } catch (_) {}
    }

    const postcodeInput = page.locator('input[type="text"], input').first();
    await postcodeInput.fill(postcode);

    const findBtn = page.locator('input[type="submit"], button').filter({ hasText: /find property/i }).first();
    if (await findBtn.count()) await findBtn.click();
    else await page.keyboard.press("Enter");

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);

    const selects = page.locator("select");
    const selectCount = await selects.count();
    if (selectCount === 0) return [];

    for (let i = 0; i < selectCount; i++) {
      const select = selects.nth(i);
      const options = await select.locator("option").allTextContents();
      const cleaned = options.map(o => o.trim()).filter(o => o && !o.toLowerCase().includes("select premises"));
      if (cleaned.length) return cleaned;
    }
    return [];
  } finally {
    await browser.close();
  }
}

async function lookupBinCollections(postcode, addressQuery) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    await page.goto("https://secure.derby.gov.uk/binday/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    const cookieBtn = page.locator("#allow-all-cookies");
    if (await cookieBtn.count()) {
      try {
        if (await cookieBtn.isVisible()) {
          await cookieBtn.click();
          await page.waitForTimeout(500);
        }
      } catch (_) {}
    }

    const postcodeInput = page.locator('input[type="text"], input').first();
    await postcodeInput.fill(postcode);

    const findBtn = page.locator('input[type="submit"], button').filter({ hasText: /find property/i }).first();
    if (await findBtn.count()) await findBtn.click();
    else await page.keyboard.press("Enter");

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);

    const selects = page.locator("select");
    const selectCount = await selects.count();
    if (selectCount === 0) return [];

    let matched = false;
    for (let i = 0; i < selectCount; i++) {
      const select = selects.nth(i);
      const options = await select.locator("option").allTextContents();
      const chosen = options.find(opt => propertyMatchesQuery(opt, addressQuery));
      if (chosen) {
        matched = true;
        await select.selectOption({ label: chosen });
        await Promise.all([
          page.waitForLoadState("domcontentloaded").catch(() => {}),
          select.evaluate(el => {
            const form = el.closest("form");
            if (form) form.submit();
          })
        ]);
        await page.waitForTimeout(2000);
        break;
      }
    }

    if (!matched) return [];
    const bodyText = (await page.textContent("body")) || "";
    return extractBinCollections(bodyText);
  } finally {
    await browser.close();
  }
}

async function sendWhatsApp(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_FROM,
    to,
    body
  });
}

function twimlMessage(text) {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const resp = new MessagingResponse();
  resp.message(text);
  return resp.toString();
}

function getOrCreateUser(store, phone) {
  if (!store.users[phone]) {
    store.users[phone] = {
      phone,
      state: "new",
      paused: false,
      postcode: "",
      addressQuery: "",
      label: "",
      pendingMatches: [],
      createdAt: new Date().toISOString()
    };
  }
  return store.users[phone];
}

function buildReminderMessage(label, dueTomorrow, upcoming) {
  const dueLines = dueTomorrow.map(item => {
    const info = binLabelAndEmoji(item.binType);
    return `${info.emoji} ${info.label}`;
  });

  const upcomingLines = upcoming.slice(0, 3).map(item => {
    const info = binLabelAndEmoji(item.binType);
    return `${info.emoji} ${info.label} – ${titleCase(item.date)}`;
  });

  return [
    `🗑️ ${APP_NAME}`,
    "",
    label ? `Address: ${label}` : null,
    ...dueLines,
    "",
    "Tomorrow",
    "Put it out tonight.",
    upcomingLines.length ? "" : null,
    upcomingLines.length ? "Coming up:" : null,
    ...upcomingLines
  ].filter(Boolean).join("\n");
}

async function confirmSubscriptionMessage(user) {
  const collections = await lookupBinCollections(user.postcode, user.addressQuery);
  const lines = [
    "Perfect 👍",
    "",
    "You’re now subscribed for:",
    `${user.label}, Derby`,
    "",
    `I’ll remind you at ${REMINDER_TIME_TEXT} the evening before collection.`
  ];

  if (collections.length) {
    const first = collections[0];
    const info = binLabelAndEmoji(first.binType);
    lines.push("", "Next collection:", `${info.emoji} ${info.label}`, `${titleCase(first.date)}`);
  }

  lines.push("", "Text NEXT for your next bin day.", "Text STOP to pause reminders.");
  return lines.join("\n");
}

async function handlePendingAddressSelection(user, body) {
  const upper = (body || "").trim().toUpperCase();

  if (upper === "NO") {
    user.pendingMatches = [];
    user.state = "awaiting_postcode_or_address";
    return [
      "No problem.",
      "",
      "Please send your postcode and house number again.",
      "",
      "Example:",
      "DE22 1HH 14"
    ].join("\n");
  }

  if (upper === "YES" && user.pendingMatches.length === 1) {
    const choice = user.pendingMatches[0];
    user.addressQuery = choice;
    user.label = choice;
    user.pendingMatches = [];
    user.state = "complete";
    user.paused = false;
    return await confirmSubscriptionMessage(user);
  }

  const numeric = parseInt((body || "").trim(), 10);
  if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= user.pendingMatches.length) {
    const choice = user.pendingMatches[numeric - 1];
    user.addressQuery = choice;
    user.label = choice;
    user.pendingMatches = [];
    user.state = "complete";
    user.paused = false;
    return await confirmSubscriptionMessage(user);
  }

  return "Please reply YES to confirm, NO to try again, or send the number of the correct address.";
}

async function handleQuickSetup(user, text) {
  const parsed = parseQuickSetup(text);

  if (!parsed) {
    return [
      "Please send your postcode and house number.",
      "",
      "Example:",
      "DE22 1HH 14"
    ].join("\n");
  }

  user.postcode = parsed.postcode;

  if (parsed.type === "postcode_only") {
    user.state = "awaiting_postcode_or_address";
    return [
      "Thanks.",
      "",
      "Now send your house number or house number and street name.",
      "",
      "Examples:",
      "14",
      "14 Parkfields Drive"
    ].join("\n");
  }

  const options = await getAddressOptionsForPostcode(parsed.postcode);
  const matches = options.filter(option => propertyMatchesQuery(option, parsed.query));

  if (matches.length === 0) {
    user.state = "awaiting_postcode_or_address";
    return [
      "I couldn’t match that address.",
      "",
      "Please send your postcode and house number again.",
      "",
      "Example:",
      "DE22 1HH 14"
    ].join("\n");
  }

  if (matches.length === 1) {
    user.addressQuery = matches[0];
    user.label = matches[0];
    user.pendingMatches = [];
    user.state = "complete";
    user.paused = false;
    return await confirmSubscriptionMessage(user);
  }

  user.pendingMatches = matches.slice(0, 5);
  user.state = "awaiting_address_confirmation";
  return [
    "I found more than one possible match.",
    "",
    ...user.pendingMatches.map((m, i) => `${i + 1}. ${m}`),
    "",
    "Reply with the number of the correct address."
  ].join("\n");
}

async function handleCommand(from, bodyRaw) {
  const body = (bodyRaw || "").trim();
  const upper = body.toUpperCase();
  const store = loadStore();
  const user = getOrCreateUser(store, from);

  if (upper === "JOIN") {
    user.state = "awaiting_postcode_or_address";
    user.paused = false;
    user.pendingMatches = [];
    saveStore(store);
    return [
      "Hi 👋",
      "",
      `I’m the ${APP_NAME}.`,
      `I’ll send you a WhatsApp message at ${REMINDER_TIME_TEXT} the evening before your bin collection.`,
      "",
      "Send your postcode and house number in one message.",
      "",
      "Example:",
      "DE22 1HH 14"
    ].join("\n");
  }

  if (user.state === "awaiting_postcode_or_address") {
    const reply = await handleQuickSetup(user, body);
    saveStore(store);
    return reply;
  }

  if (user.state === "awaiting_address_confirmation") {
    const reply = await handlePendingAddressSelection(user, body);
    saveStore(store);
    return reply;
  }

  if (upper === "HELP") {
    return [
      `🗑️ ${APP_NAME}`,
      "",
      "Commands:",
      "JOIN - set up reminders",
      "NEXT - next bin collection",
      "STOP - pause reminders",
      "START - resume reminders",
      "HELP - show this help"
    ].join("\n");
  }

  if (upper === "STOP") {
    user.paused = true;
    saveStore(store);
    return ["Reminders paused.", "", "Text START anytime to turn them back on."].join("\n");
  }

  if (upper === "START") {
    user.paused = false;
    if (!user.postcode || !user.addressQuery) {
      user.state = "awaiting_postcode_or_address";
      user.pendingMatches = [];
      saveStore(store);
      return ["Let’s set you up again.", "", "Please send your postcode and house number.", "", "Example:", "DE22 1HH 14"].join("\n");
    }

    user.state = "complete";
    saveStore(store);
    return ["You’re back on 👍", "", `I’ll remind you at ${REMINDER_TIME_TEXT} the evening before collection.`].join("\n");
  }

  if (upper === "NEXT") {
    if (!user.postcode || !user.addressQuery) {
      return ["You are not set up yet.", "", "Text JOIN to get started."].join("\n");
    }

    const collections = await lookupBinCollections(user.postcode, user.addressQuery);
    if (!collections.length) return "I couldn’t find your collection details right now.";

    const first = collections[0];
    const info = binLabelAndEmoji(first.binType);

    return [
      `🗑️ ${APP_NAME}`,
      "",
      `Address: ${user.label || user.addressQuery}`,
      `${info.emoji} ${info.label}`,
      `Next: ${titleCase(first.date)}`
    ].join("\n");
  }

  return ["Hi 👋", "", `Welcome to ${APP_NAME}.`, "Text JOIN to set up reminders.", "Text HELP for options."].join("\n");
}

async function sendDailyReminders() {
  const store = loadStore();
  const tomorrowText = getTomorrowText();
  const markerDay = todayKey();

  for (const phone of Object.keys(store.users)) {
    const user = store.users[phone];
    if (user.paused) continue;
    if (user.state !== "complete") continue;
    if (!user.postcode || !user.addressQuery) continue;

    const sentKey = `${phone}__${markerDay}`;
    if (store.sent[sentKey]) continue;

    const collections = await lookupBinCollections(user.postcode, user.addressQuery);
    if (!collections.length) continue;

    const dueTomorrow = collections.filter(c => c.date === tomorrowText);
    if (!dueTomorrow.length) continue;

    const upcoming = collections.filter(c => c.date !== tomorrowText);
    const message = buildReminderMessage(user.label || user.addressQuery, dueTomorrow, upcoming);

    await sendWhatsApp(phone, message);
    store.sent[sentKey] = { at: new Date().toISOString(), phone, date: markerDay };
    saveStore(store);
    console.log(`Reminder sent to ${phone}`);
  }
}

app.get("/", (req, res) => {
  res.send(`${APP_NAME} is running`);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: APP_NAME,
    timezone: TIMEZONE,
    reminder_time: REMINDER_TIME_TEXT,
    onboarding_model: "postcode + house number"
  });
});

app.post("/whatsapp", async (req, res) => {
  const from = normalizeWhatsApp(req.body.From || "");
  const body = req.body.Body || "";

  try {
    const reply = await handleCommand(from, body);
    res.type("text/xml").send(twimlMessage(reply));
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.type("text/xml").send(twimlMessage("Something went wrong. Please try again."));
  }
});

app.get("/run-reminders", async (req, res) => {
  const key = req.query.key || "";
  if (RUN_KEY && key !== RUN_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });

  try {
    await sendDailyReminders();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`${APP_NAME} listening on ${PORT}`);
});
