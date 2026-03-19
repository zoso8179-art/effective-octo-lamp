const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─── Persistent user storage ─────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, "users.json");

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    }
  } catch (err) {
    console.error("[storage] Failed to load users.json:", err.message);
  }
  return {};
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("[storage] Failed to save users.json:", err.message);
  }
}

const users = loadUsers();
console.log(`[startup] Loaded ${Object.keys(users).length} user(s) from storage`);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

function twiml(text) {
  return `<Response><Message>${text}</Message></Response>`;
}

function getTomorrowString() {
  return DateTime.now()
    .setZone("Europe/London")
    .plus({ days: 1 })
    .toFormat("d MMMM yyyy")
    .toLowerCase();
}

function capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function buildReminder(bin) {
  const icons = {
    recycling: "🔵",
    "general waste": "⚫",
    garden: "🟤",
    food: "🟢"
  };

  return `🗑️ Bin Reminder

${capitalise(bin.date)}:
${icons[bin.binType] || "🗑️"} ${capitalise(bin.binType)}

Put it out tonight 👍`;
}

// ─── Scraper ──────────────────────────────────────────────────────────────────
async function getCollections(postcode) {
  const url = `https://www.derby.gov.uk/environment/bins-and-recycling/bin-collection-day/?uprn=&postcode=${encodeURIComponent(postcode)}`;
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BinReminderBot/8.0)"
      }
    });

    const $ = cheerio.load(response.data);
    const collections = [];

    // Strategy 1: look for structured table or list rows with dates
    $("table tr, .bin-collection, .collection-row, li").each((i, el) => {
      const rowText = $(el).text().toLowerCase().trim();
      const dateMatch = rowText.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/);
      const typeMatch = rowText.match(/\b(general waste|recycling|garden|food)\b/);
      if (dateMatch && typeMatch) {
        const dateStr = `${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3]}`;
        if (!collections.find(c => c.date === dateStr && c.binType === typeMatch[1])) {
          collections.push({ date: dateStr, binType: typeMatch[1] });
        }
      }
    });

    // Strategy 2: fallback regex over full body text if nothing found above
    if (collections.length === 0) {
      const bodyText = $("body").text().toLowerCase();
      const regex = /(\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4})[^\n]*?(general waste|recycling|garden|food)/g;
      const matches = [...bodyText.matchAll(regex)];
      for (const m of matches) {
        const dateStr = m[1].replace(/\s+/g, " ").trim();
        if (!collections.find(c => c.date === dateStr && c.binType === m[2])) {
          collections.push({ date: dateStr, binType: m[2] });
        }
      }
    }

    console.log(`[scraper] ${postcode} → ${collections.length} collection(s) found`);
    return collections;

  } catch (err) {
    console.error(`[scraper] Failed for ${postcode}:`, err.message);
    return [];
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("V8 Derby Bin Reminder is running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "v8",
    app: "Derby Bin Reminder",
    timezone: "Europe/London",
    reminder_time: "18:00",
    active_users: Object.values(users).filter(u => u.step === "active").length,
    total_users: Object.keys(users).length
  });
});

app.post("/whatsapp", async (req, res) => {
  const text = (req.body.Body || "").trim();
  const from = req.body.From;

  if (!from) {
    return res.status(400).send("Bad request");
  }

  // New user — start onboarding
  if (!users[from]) {
    users[from] = { step: "postcode", paused: false };
    saveUsers();
    return res.send(twiml(`🗑️ Derby Bin Reminder

Never forget bin day again.

Send your postcode (e.g. DE1 1AA):`));
  }

  const user = users[from];
  const upper = text.toUpperCase().trim();

  // RESET always available
  if (upper === "RESET") {
    delete users[from];
    saveUsers();
    return res.send(twiml(`Starting over 🔄

Send your postcode (e.g. DE1 1AA):`));
  }

  // Commands only available once active
  if (user.step === "active") {
    if (upper === "STOP") {
      user.paused = true;
      saveUsers();
      return res.send(twiml("Reminders paused ⏸️\n\nSend START to resume."));
    }

    if (upper === "START") {
      user.paused = false;
      saveUsers();
      return res.send(twiml("Reminders resumed ✅"));
    }

    if (upper === "HELP") {
      return res.send(twiml(`Commands:
NEXT – next collection
TOMORROW – is there a collection tomorrow?
STOP – pause reminders
START – resume reminders
RESET – change your postcode`));
    }

    if (upper === "NEXT") {
      const collections = await getCollections(user.postcode);
      if (!collections.length) {
        return res.send(twiml("I couldn't find your next collection right now. Try again later."));
      }
      const c = collections[0];
      return res.send(twiml(`Next collection:
${capitalise(c.date)} – ${capitalise(c.binType)}`));
    }

    if (upper === "TOMORROW") {
      const collections = await getCollections(user.postcode);
      const tomorrowText = getTomorrowString();
      const match = collections.find((d) => d.date === tomorrowText);
      if (!match) return res.send(twiml("No bin collection tomorrow."));
      return res.send(twiml(buildReminder(match)));
    }
  }

  // Onboarding: step = postcode
  if (user.step === "postcode") {
    if (!UK_POSTCODE.test(text)) {
      return res.send(twiml("That doesn't look like a valid postcode.\n\nPlease send your postcode (e.g. DE1 1AA):"));
    }
    user.postcode = text.toUpperCase().replace(/\s+/g, " ").trim();
    user.step = "confirm";
    saveUsers();
    return res.send(twiml(`Got it 👍

Postcode: ${user.postcode}

Reply YES to confirm, or send a different postcode to correct it.`));
  }

  // Onboarding: step = confirm
  if (user.step === "confirm") {
    if (upper === "YES") {
      console.log(`[onboarding] New user confirmed: ${from} → ${user.postcode}`);
      const collections = await getCollections(user.postcode);
      user.step = "active";
      saveUsers();

      if (!collections.length) {
        return res.send(twiml(`You're set ✅

I'll remind you at 18:00 the night before your bin collection.

Send HELP for commands.`));
      }

      const next = collections[0];
      return res.send(twiml(`You're set ✅

Next collection:
${capitalise(next.date)} – ${capitalise(next.binType)}

You'll get a reminder at 18:00 the night before.

Send HELP for commands.`));
    }

    // They sent a new postcode instead of YES — treat it as a correction
    if (UK_POSTCODE.test(text)) {
      user.postcode = text.toUpperCase().replace(/\s+/g, " ").trim();
      saveUsers();
      return res.send(twiml(`Updated 👍

Postcode: ${user.postcode}

Reply YES to confirm.`));
    }

    return res.send(twiml(`Reply YES to confirm your postcode (${user.postcode}), or send a new postcode to correct it.`));
  }

  // Active user sends something unrecognised
  if (user.step === "active") {
    return res.send(twiml("Send HELP for available commands."));
  }

  return res.send(twiml("Send HELP for available commands."));
});

// ─── Reminder runner ──────────────────────────────────────────────────────────
app.get("/run-reminders", async (req, res) => {
  if (req.query.key !== process.env.RUN_KEY) {
    return res.status(403).send("Forbidden");
  }

  const tomorrowText = getTomorrowString();
  console.log(`[reminders] Running for: ${tomorrowText}`);

  const activeUsers = Object.entries(users).filter(
    ([, u]) => !u.paused && u.step === "active"
  );

  console.log(`[reminders] ${activeUsers.length} active user(s) to check`);

  // Cache scrape results per postcode — avoid hitting the council site repeatedly
  const cache = {};
  let sent = 0;
  let errors = 0;

  for (const [number, user] of activeUsers) {
    try {
      if (!cache[user.postcode]) {
        cache[user.postcode] = await getCollections(user.postcode);
      }

      const match = cache[user.postcode].find((d) => d.date === tomorrowText);

      if (match) {
        await client.messages.create({
          from: process.env.TWILIO_FROM,
          to: number,
          body: buildReminder(match)
        });
        console.log(`[reminders] Sent to ${number} (${user.postcode}) – ${match.binType}`);
        sent++;
      }
    } catch (err) {
      console.error(`[reminders] Failed for ${number}:`, err.message);
      errors++;
    }
  }

  console.log(`[reminders] Done. Sent: ${sent}, Errors: ${errors}`);
  res.json({ ok: true, sent, errors, checked: activeUsers.length });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`V8 Derby Bin Reminder running on port ${PORT}`);
});
