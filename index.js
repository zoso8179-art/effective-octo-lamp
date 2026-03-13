require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const { chromium } = require("playwright");
const twilio = require("twilio");

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || "./data";
const DATA_FILE = path.join(DATA_DIR, "bot-data.json");
const APP_NAME = process.env.APP_NAME || "Bin Reminder";
const TIMEZONE = process.env.TIMEZONE || "Europe/London";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

ensureStore();

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          users: {},
          sent: {}
        },
        null,
        2
      )
    );
  }
}

function loadStore() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function normaliseWhatsapp(value) {
  if (!value) return "";
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

function normaliseText(text) {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim()
    .toLowerCase();
}

function titleCase(s) {
  return (s || "").replace(/\b\w/g, m => m.toUpperCase());
}

function getTomorrowText() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  return tomorrow
    .toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: TIMEZONE
    })
    .toLowerCase();
}

function todayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

function classifyBinType(text) {
  const t = (text || "").toLowerCase();

  if (t.includes("general waste") || t.includes("black bin")) {
    return "general waste";
  }
  if (t.includes("recycling") || t.includes("blue bin")) {
    return "recycling";
  }
  if (t.includes("garden") || t.includes("brown bin")) {
    return "garden waste";
  }
  if (t.includes("food waste")) {
    return "food waste";
  }

  return "unknown";
}

function binLabelAndEmoji(binType) {
  const t = (binType || "").toLowerCase();

  if (t.includes("recycl")) {
    return { label: "Blue bin – Recycling", emoji: "🟦" };
  }
  if (t.includes("garden")) {
    return { label: "Brown bin – Garden waste", emoji: "🟫" };
  }
  if (t.includes("food")) {
    return { label: "Green bin – Food waste", emoji: "🟩" };
  }
  if (t.includes("general") || t.includes("black")) {
    return { label: "Black bin – General waste", emoji: "⬛" };
  }

  return { label: "Bin collection", emoji: "🗑️" };
}

function extractBinCollections(bodyText) {
  const text = normaliseText(bodyText);

  const pattern =
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s+(\d{1,2}\s+[a-z]+\s+\d{4})\s*:\s*([a-z ]+?bin collection)\b/gi;

  const results = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const date = match[1].toLowerCase().trim();
    const description = match[2].toLowerCase().trim();

    results.push({
      date,
      binType: classifyBinType(description),
      description
    });
  }

  const seen = new Set();

  return results.filter(item => {
    const key = `${item.date}__${item.binType}__${item.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      } catch {}
    }

    const postcodeInput = page.locator('input[type="text"], input').first();
    await postcodeInput.fill(postcode);

    const findBtn = page
      .locator('input[type="submit"], button')
      .filter({ hasText: /find property/i })
      .first();

    if (await findBtn.count()) {
      await findBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);

    const selects = page.locator("select");
    const selectCount = await selects.count();

    if (selectCount === 0) {
      return [];
    }

    let matched = false;

    for (let i = 0; i < selectCount; i++) {
      const select = selects.nth(i);
      const options = await select.locator("option").allTextContents();

      const chosen = options.find(opt =>
        opt.toLowerCase().includes(addressQuery.toLowerCase())
      );

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

    if (!matched) {
      return [];
    }

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
      createdAt: new Date().toISOString()
    };
  }
  return store.users[phone];
}

function buildReminderMessage(label, dueTomorrow, upcoming) {
  const dueLines = dueTomorrow.map(item => {
    const { label: binLabel, emoji } = binLabelAndEmoji(item.binType);
    return `${emoji} ${binLabel}`;
  });

  const upcomingLines = upcoming.slice(0, 3).map(item => {
    const { label: binLabel, emoji } = binLabelAndEmoji(item.binType);
    return `${emoji} ${binLabel} – ${titleCase(item.date)}`;
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
  ]
    .filter(Boolean)
    .join("\n");
}

async function handleJoinFlow(user, body) {
  const text = body.trim();

  if (user.state === "awaiting_postcode") {
    user.postcode = text.toUpperCase();
    user.state = "awaiting_address";

    return [
      "Thanks.",
      "",
      "Now send your house number and street name.",
      "Example:",
      "14 Parkfields Drive"
    ].join("\n");
  }

  if (user.state === "awaiting_address") {
    user.addressQuery = text;
    user.label = text;
    user.state = "complete";
    user.paused = false;

    return [
      "All set 👍",
      "",
      `Address: ${user.label}`,
      `Postcode: ${user.postcode}`,
      "",
      "I’ll remind you at 18:00 the night before collection.",
      "",
      "Text NEXT for the next bin day.",
      "Text STOP to pause reminders."
    ].join("\n");
  }

  return null;
}

async function handleCommand(from, bodyRaw) {
  const body = (bodyRaw || "").trim();
  const upper = body.toUpperCase();

  const store = loadStore();
  const user = getOrCreateUser(store, from);

  if (upper === "JOIN") {
    user.state = "awaiting_postcode";
    user.paused = false;
    saveStore(store);

    return [
      `Welcome to ${APP_NAME}.`,
      "",
      "Please send your postcode.",
      "Example: DE22 1HH"
    ].join("\n");
  }

  if (user.state === "awaiting_postcode" || user.state === "awaiting_address") {
    const reply = await handleJoinFlow(user, body);
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
    return [
      "Reminders paused.",
      "",
      "Text START anytime to turn them back on."
    ].join("\n");
  }

  if (upper === "START") {
    user.paused = false;

    if (!user.postcode || !user.addressQuery) {
      user.state = "awaiting_postcode";
      saveStore(store);
      return [
        "Let’s set you up again.",
        "",
        "Please send your postcode."
      ].join("\n");
    }

    user.state = "complete";
    saveStore(store);

    return [
      "You’re back on 👍",
      "",
      "I’ll remind you at 18:00 the night before collection."
    ].join("\n");
  }

  if (upper === "NEXT") {
    if (!user.postcode || !user.addressQuery) {
      return [
        "You are not set up yet.",
        "",
        "Text JOIN to get started."
      ].join("\n");
    }

    const collections = await lookupBinCollections(user.postcode, user.addressQuery);

    if (!collections.length) {
      return "I couldn’t find your collection details right now.";
    }

    const first = collections[0];
    const { label, emoji } = binLabelAndEmoji(first.binType);

    return [
      `🗑️ ${APP_NAME}`,
      "",
      `Address: ${user.label || user.addressQuery}`,
      `${emoji} ${label}`,
      `Next: ${titleCase(first.date)}`
    ].join("\n");
  }

  return [
    `Welcome to ${APP_NAME}.`,
    "",
    "Text JOIN to set up reminders.",
    "Text HELP for options."
  ].join("\n");
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

    const message = buildReminderMessage(
      user.label || user.addressQuery,
      dueTomorrow,
      upcoming
    );

    await sendWhatsApp(phone, message);

    store.sent[sentKey] = {
      at: new Date().toISOString(),
      phone,
      date: markerDay
    };

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
    reminder_time: "18:00"
  });
});

app.post("/whatsapp", async (req, res) => {
  const from = normaliseWhatsapp(req.body.From || "");
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
  if ((process.env.RUN_KEY || "") && key !== process.env.RUN_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

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
