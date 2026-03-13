require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const { chromium } = require("playwright");
const twilio = require("twilio");

const APP_NAME = process.env.APP_NAME || "Derby Bin Bot";
const PORT = parseInt(process.env.PORT || "3000", 10);
const TZ = process.env.TIMEZONE || "Europe/London";
const DAILY_CRON = process.env.DAILY_CRON || "0 19 * * *";
const DEFAULT_POSTCODE = (process.env.POSTCODE || "").trim();
const DEFAULT_ADDRESS_QUERY = (process.env.ADDRESS_QUERY || "").trim();
const DEFAULT_ADMIN_NUMBER = normalizeWhatsAppNumber(process.env.TWILIO_TO || "");
const ENABLE_CRON = String(process.env.ENABLE_CRON || "true").toLowerCase() === "true";
const RUN_ON_START = String(process.env.RUN_ON_START || "false").toLowerCase() === "true";
const DATA_DIR = resolveDataDir(process.env.DATA_DIR || "/data");
const DATA_FILE = path.join(DATA_DIR, "bot-data.json");
const MAX_UPCOMING_LINES = parseInt(process.env.MAX_UPCOMING_LINES || "4", 10);

if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  console.error("Missing Twilio credentials.");
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

const HELP_TEXT = [
  `🗑️ ${APP_NAME}`,
  "",
  "Commands:",
  "HELP - show commands",
  "JOIN - add your default address from env",
  "ADD <postcode> | <address> - add an address",
  "LIST - show your saved addresses",
  "NEXT - next collection for your first active address",
  "SCHEDULE - next dates for all active addresses",
  "PAUSE - stop reminders",
  "START - resume reminders",
  "REMOVE <id> - delete one address",
  "TEST - get instructions",
  "TESTSEND - send yourself a live test message",
  "",
  "Example:",
  "ADD DE22 1HH | 14 Parkfields Drive"
].join("\n");

function resolveDataDir(preferred) {
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.join(process.cwd(), "data");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const seed = { users: {}, sent: {} };
    if (DEFAULT_ADMIN_NUMBER && DEFAULT_POSTCODE && DEFAULT_ADDRESS_QUERY) {
      seed.users[DEFAULT_ADMIN_NUMBER] = {
        phone: DEFAULT_ADMIN_NUMBER,
        paused: false,
        addresses: [{
          id: "a1",
          postcode: DEFAULT_POSTCODE,
          addressQuery: DEFAULT_ADDRESS_QUERY,
          label: DEFAULT_ADDRESS_QUERY,
          active: true
        }],
        createdAt: new Date().toISOString()
      };
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
  }
}

function loadStore() { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
function saveStore(store) { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); }

function normalizeWhatsAppNumber(value) {
  if (!value) return "";
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

function getOrCreateUser(store, phone) {
  if (!store.users[phone]) {
    store.users[phone] = { phone, paused: false, addresses: [], createdAt: new Date().toISOString() };
  }
  return store.users[phone];
}

function nextAddressId(user) {
  const nums = user.addresses
    .map(a => parseInt(String(a.id || "").replace(/[^\d]/g, ""), 10))
    .filter(n => !Number.isNaN(n));
  return `a${nums.length ? Math.max(...nums) + 1 : 1}`;
}

function normaliseText(text) {
  return (text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n+/g, "\n").trim().toLowerCase();
}
function titleCase(s) { return (s || "").replace(/\b\w/g, m => m.toUpperCase()); }
function getTomorrowText() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: TZ }).toLowerCase();
}
function todayKey() { return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); }

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
  if (t.includes("recycl")) return { label: "Recycling", emoji: "🟦" };
  if (t.includes("garden")) return { label: "Garden waste", emoji: "🟫" };
  if (t.includes("food")) return { label: "Food waste", emoji: "🟩" };
  if (t.includes("general") || t.includes("black")) return { label: "General waste", emoji: "⬛" };
  return { label: "Bin collection", emoji: "🗑️" };
}

function makeReminderMessage(label, dueTomorrow, upcoming) {
  const tomorrowLines = dueTomorrow.map(item => {
    const { label: l, emoji } = binLabelAndEmoji(item.binType);
    return `${emoji} ${l} – tomorrow`;
  });
  const upcomingLines = upcoming.map(item => {
    const { label: l, emoji } = binLabelAndEmoji(item.binType);
    return `${emoji} ${l} – ${titleCase(item.date)}`;
  });
  return [
    `🗑️ ${APP_NAME}`,
    "",
    label ? `Address: ${label}` : null,
    ...tomorrowLines,
    upcomingLines.length ? "" : null,
    upcomingLines.length ? "Upcoming:" : null,
    ...upcomingLines,
    "",
    "Put it out tonight."
  ].filter(Boolean).join("\n");
}

function extractBinCollections(bodyText) {
  const text = normaliseText(bodyText);
  const pattern = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s+(\d{1,2}\s+[a-z]+\s+\d{4})\s*:\s*([a-z ]+?bin collection)\b/gi;
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

async function lookupBinCollections(postcode, addressQuery) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  try {
    await page.goto("https://secure.derby.gov.uk/binday/", { waitUntil: "domcontentloaded", timeout: 60000 });

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
      const chosen = options.find(opt => opt.toLowerCase().includes(addressQuery.toLowerCase()));
      if (chosen) {
        matched = true;
        await select.selectOption({ label: chosen });
        await Promise.all([
          page.waitForLoadState("domcontentloaded").catch(() => {}),
          select.evaluate(el => { const form = el.closest("form"); if (form) form.submit(); })
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
  await twilioClient.messages.create({ from: process.env.TWILIO_FROM, to, body });
}

function twimlMessage(text) {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const resp = new MessagingResponse();
  resp.message(text);
  return resp.toString();
}

async function buildScheduleText(address) {
  const collections = await lookupBinCollections(address.postcode, address.addressQuery);
  if (!collections.length) return `Could not find schedule for ${address.label || address.addressQuery}.`;
  const lines = collections.slice(0, 6).map(item => {
    const { label, emoji } = binLabelAndEmoji(item.binType);
    return `${emoji} ${label} – ${titleCase(item.date)}`;
  });
  return [`🗓️ ${address.label || address.addressQuery}`, ...lines].join("\n");
}

async function sendDailyReminders() {
  const store = loadStore();
  const tomorrowText = getTomorrowText();
  const dayMarker = todayKey();

  for (const phone of Object.keys(store.users)) {
    const user = store.users[phone];
    if (user.paused) continue;

    for (const address of user.addresses.filter(a => a.active)) {
      const collections = await lookupBinCollections(address.postcode, address.addressQuery);
      if (!collections.length) continue;

      const dueTomorrow = collections.filter(c => c.date === tomorrowText);
      if (!dueTomorrow.length) continue;

      const upcoming = collections.filter(c => c.date !== tomorrowText).slice(0, MAX_UPCOMING_LINES);
      const sentKey = `${phone}__${address.id}__${dayMarker}`;

      if (store.sent[sentKey]) continue;

      const msg = makeReminderMessage(address.label || address.addressQuery, dueTomorrow, upcoming);
      await sendWhatsApp(phone, msg);

      store.sent[sentKey] = { at: new Date().toISOString(), phone, addressId: address.id, date: dayMarker };
      saveStore(store);
      console.log(`Reminder sent to ${phone} for ${address.label || address.addressQuery}`);
    }
  }
}

function scheduleCron() {
  if (!ENABLE_CRON) return;
  setInterval(async () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
    const minute = now.getMinutes();
    const hour = now.getHours();
    const [cronMin, cronHour] = DAILY_CRON.split(" ");
    if (String(minute) === cronMin && String(hour) === cronHour) {
      const stamp = `${todayKey()}-${hour}-${minute}`;
      const lockFile = path.join(DATA_DIR, "cron-lock.txt");
      const previous = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, "utf8") : "";
      if (previous !== stamp) {
        fs.writeFileSync(lockFile, stamp);
        try { await sendDailyReminders(); } catch (err) { console.error("Daily reminder sweep failed:", err.message); }
      }
    }
  }, 30000);
}

async function handleCommand(from, bodyRaw) {
  const body = (bodyRaw || "").trim();
  const upper = body.toUpperCase();

  const store = loadStore();
  const user = getOrCreateUser(store, from);

  if ((upper === "JOIN" || upper === "START") && DEFAULT_POSTCODE && DEFAULT_ADDRESS_QUERY && user.addresses.length === 0) {
    user.paused = false;
    user.addresses.push({
      id: nextAddressId(user),
      postcode: DEFAULT_POSTCODE,
      addressQuery: DEFAULT_ADDRESS_QUERY,
      label: DEFAULT_ADDRESS_QUERY,
      active: true
    });
    saveStore(store);
    return `You are in.\nAdded: ${DEFAULT_ADDRESS_QUERY} (${DEFAULT_POSTCODE})`;
  }

  if (upper === "HELP") return HELP_TEXT;
  if (upper === "PAUSE") { user.paused = true; saveStore(store); return "Reminders paused."; }
  if (upper === "START") { user.paused = false; saveStore(store); return "Reminders resumed."; }

  if (upper === "LIST") {
    if (!user.addresses.length) return "No saved addresses. Use: ADD DE22 1HH | 14 Parkfields Drive";
    return user.addresses.map(a => `${a.id} - ${a.label || a.addressQuery} (${a.postcode}) ${a.active ? "✅" : "⏸️"}`).join("\n");
  }

  if (upper.startswith?.("ADD ")) return "Format error";
  if (upper.startsWith("ADD ")) {
    const payload = body.slice(4).trim();
    const parts = payload.split("|").map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return "Format: ADD DE22 1HH | 14 Parkfields Drive";
    const [postcode, addressQuery, label] = parts;
    user.addresses.push({ id: nextAddressId(user), postcode, addressQuery, label: label || addressQuery, active: true });
    user.paused = false;
    saveStore(store);
    return `Added:\n${label || addressQuery}\n${postcode}`;
  }

  if (upper.startsWith("REMOVE ")) {
    const id = body.slice(7).trim();
    const before = user.addresses.length;
    user.addresses = user.addresses.filter(a => a.id !== id);
    saveStore(store);
    return user.addresses.length < before ? `Removed ${id}.` : `Could not find ${id}.`;
  }

  if (upper === "NEXT") {
    const address = user.addresses.find(a => a.active);
    if (!address) return "No active address. Use: ADD DE22 1HH | 14 Parkfields Drive";
    const collections = await lookupBinCollections(address.postcode, address.addressQuery);
    if (!collections.length) return "Could not find your schedule right now.";
    const first = collections[0];
    const info = binLabelAndEmoji(first.binType);
    return [`🗑️ ${address.label || address.addressQuery}`, `${info.emoji} ${info.label}`, `Next: ${titleCase(first.date)}`].join("\n");
  }

  if (upper === "SCHEDULE") {
    if (!user.addresses.length) return "No saved addresses. Use: ADD DE22 1HH | 14 Parkfields Drive";
    const chunks = [];
    for (const address of user.addresses.filter(a => a.active)) chunks.push(await buildScheduleText(address));
    return chunks.join("\n\n");
  }

  if (upper === "TEST") return "Send TESTSEND if you want a live WhatsApp test message.";

  if (upper === "TESTSEND") {
    const msg = [`🗑️ ${APP_NAME}`, "", "⬛ General waste – tomorrow", "🟦 Recycling – 25 March 2026", "🟫 Garden waste – 25 March 2026", "", "Put it out tonight."].join("\n");
    await sendWhatsApp(from, msg);
    return "Test message sent.";
  }

  return HELP_TEXT;
}

app.get("/", (req, res) => { res.send(`${APP_NAME} is running`); });
app.get("/health", (req, res) => { res.json({ ok: true, app: APP_NAME, cron: ENABLE_CRON, dailyCron: DAILY_CRON, timezone: TZ }); });

app.post("/whatsapp", async (req, res) => {
  const from = normalizeWhatsAppNumber(req.body.From || "");
  const body = req.body.Body || "";
  try {
    const reply = await handleCommand(from, body);
    res.type("text/xml").send(twimlMessage(reply));
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.type("text/xml").send(twimlMessage("Something went wrong. Try HELP."));
  }
});

app.get("/run-reminders", async (req, res) => {
  const key = req.query.key || "";
  if ((process.env.RUN_KEY || "") && key !== process.env.RUN_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  try { await sendDailyReminders(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.listen(PORT, async () => {
  console.log(`${APP_NAME} listening on ${PORT}`);
  if (RUN_ON_START) { try { await sendDailyReminders(); } catch (err) { console.error("Startup reminder run failed:", err.message); } }
  scheduleCron();
});
