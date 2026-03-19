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

// ─── Persistent user storage ──────────────────────────────────────────────────
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

// ─── Bin content info ─────────────────────────────────────────────────────────
const BIN_INFO = {
  blue: `🔵 Blue bin — Dry recycling

✅ Yes:
• Paper & cardboard (magazines, boxes, envelopes)
• Food tins & drinks cans (rinsed)
• Plastic bottles, pots & trays (rinse & squash)
• Glass bottles & jars (rinse, remove lids)
• Juice/soup cartons
• Aerosol cans
• Clean foil & foil trays
• Empty plastic & metal tubes

❌ No:
• Food waste
• Nappies or sanitary products
• Plastic bags or film
• Clothing or textiles
• Electricals, vapes or batteries
• Polystyrene
• Crisp packets or sweet wrappers

Tip: Check, wash, squash before putting in.`,

  black: `⚫ Black bin — General waste (last resort)

✅ Yes:
• Nappies & sanitary products
• Non-recyclable plastics (crisp packets, cling film)
• Polystyrene packaging
• Disposable wipes & tissues
• Broken crockery
• Cat litter & pet waste (bagged)

❌ No:
• Anything recyclable (use blue bin)
• Food or garden waste (use brown bin)
• Electricals, batteries or vapes
• Textiles — donate or sell instead
• Bulky items — book a collection
• Liquids, oils or paints

Tip: Always bag and tie waste to protect crews.`,

  brown: `🟤 Brown bin — Garden & food waste

✅ Yes:
• Grass cuttings, leaves & weeds
• Hedge & shrub clippings
• Flowers & plants
• Small twigs & branches
• Food waste (from 30 March 2026 use the green container instead)

❌ No:
• Plastic bags or pots
• Soil or rubble
• Meat, fish or cooked food (goes in green food container)
• Pet waste

Note: Garden waste collection requires a brown bin subscription — sign up via Derby City Council.`,

  food: `🟢 Green container — Food waste

✅ Yes:
• Fruit & vegetable scraps
• Meat, fish & bones
• Cooked food & leftovers
• Dairy products
• Tea bags & coffee grounds
• Bread & pastries
• Eggshells

❌ No:
• Plastic bags (use compostable liners only)
• Liquids
• Packaging of any kind

Tip: Use compostable liners to keep your container clean.
Rolling out from 30 March 2026 across Derby.`
};

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
// Derby Council bin checker works in two steps:
// 1. GET SelectProperty?postcode=XX  →  HTML with <select> of addresses + UPRN values
// 2. GET /binday/{UPRN}?address=...  →  HTML with .binresult divs containing dates
//
// The house parameter (number or name) matches the correct property in the dropdown.
// Falls back to the first property if no match found.

async function getCollections(postcode, house) {
  const axiosOpts = {
    timeout: 10000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BinReminderBot/8.0)" }
  };

  try {
    // Step 1 — postcode lookup
    const cleanPostcode = postcode.replace(/\s+/g, "").toUpperCase();
    const step1Url = `https://secure.derby.gov.uk/binday/SelectProperty?postcode=${encodeURIComponent(cleanPostcode)}`;
    console.log(`[scraper] Step 1: ${step1Url}`);

    const step1 = await axios.get(step1Url, axiosOpts);
    const $1 = cheerio.load(step1.data);

    // Dropdown option text examples:
    //   "14 Smith Street, Derby, DE1 1AA"
    //   "Rosewood, 14 Smith Street, Derby, DE1 1AA"
    let selectedOption = null;

    if (house) {
      const h = house.trim().toLowerCase();
      $1("select#SelectedUprn option[value!='']").each((i, el) => {
        const optText = $1(el).text().trim().toLowerCase();
        if (
          optText.startsWith(h + " ") ||
          optText.startsWith(h + ",") ||
          optText.includes(", " + h + " ") ||
          optText.includes(", " + h + ",")
        ) {
          selectedOption = $1(el);
          return false; // break
        }
      });

      if (!selectedOption) {
        console.warn(`[scraper] No match for house "${house}" in ${postcode} — using first property`);
      }
    }

    if (!selectedOption) {
      selectedOption = $1("select#SelectedUprn option[value!='']").first();
    }

    const uprn = selectedOption.attr("value");
    const address = selectedOption.text().trim();

    if (!uprn) {
      console.error(`[scraper] No properties found for postcode: ${postcode}`);
      return [];
    }

    console.log(`[scraper] Using UPRN ${uprn} → ${address}`);

    // Step 2 — fetch bin days
    const step2Url = `https://secure.derby.gov.uk/binday/BinDays/${uprn}?address=${address}`;
    console.log(`[scraper] Step 2: ${step2Url}`);

    const step2 = await axios.get(step2Url, {
      ...axiosOpts,
      headers: {
        ...axiosOpts.headers,
        "Referer": `https://secure.derby.gov.uk/binday/SelectProperty?postcode=${cleanPostcode}`
      }
    });
    const $2 = cheerio.load(step2.data);

    const collections = [];

    // Each entry: <p><strong>Wednesday, 25 March 2026:</strong> Recycling blue bin collection</p>
    $2(".binresult .mainbintext p").each((i, el) => {
      const text = $2(el).text().trim();
      const strongText = $2(el).find("strong").text();
      const dateMatch = strongText.match(
        /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i
      );
      const typeMatch = text.match(/\b(general waste|recycling|garden|food waste|food)\b/i);

      if (dateMatch && typeMatch) {
        const dateStr = `${parseInt(dateMatch[1])} ${dateMatch[2].toLowerCase()} ${dateMatch[3]}`;
        let binType = typeMatch[1].toLowerCase();
        if (binType === "food waste") binType = "food";
        if (!collections.find(c => c.date === dateStr && c.binType === binType)) {
          collections.push({ date: dateStr, binType });
        }
      }
    });

    console.log(`[scraper] ${postcode} "${house || "first"}" → ${collections.length} collection(s) found`);
    return collections;

  } catch (err) {
    console.error(`[scraper] Failed for ${postcode}:`, err.message);
    return [];
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("V10 Derby Bin Reminder is running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "v10",
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

  // RESET — always available
  if (upper === "RESET") {
    delete users[from];
    saveUsers();
    return res.send(twiml(`Starting over 🔄

Send your postcode (e.g. DE1 1AA):`));
  }

  // BINS commands — available to everyone, even mid-onboarding
  if (upper === "BINS") {
    return res.send(twiml(`What goes in each bin?

🔵 BLUE – dry recycling
⚫ BLACK – general waste
🟤 BROWN – garden waste
🟢 FOOD – food waste

Reply with the colour for details.`));
  }

  if (upper === "BLUE")  return res.send(twiml(BIN_INFO.blue));
  if (upper === "BLACK") return res.send(twiml(BIN_INFO.black));
  if (upper === "BROWN") return res.send(twiml(BIN_INFO.brown));
  if (upper === "FOOD")  return res.send(twiml(BIN_INFO.food));

  // ── Active user commands ───────────────────────────────────────────────────
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
TOMORROW – collection tomorrow?
BINS – what goes in each bin
STOP – pause reminders
START – resume reminders
RESET – change your address`));
    }

    if (upper === "NEXT") {
      const collections = await getCollections(user.postcode, user.house);
      if (!collections.length) {
        return res.send(twiml("I couldn't find your next collection right now. Try again later."));
      }
      const c = collections[0];
      return res.send(twiml(`Next collection:
${capitalise(c.date)} – ${capitalise(c.binType)}`));
    }

    if (upper === "TOMORROW") {
      const collections = await getCollections(user.postcode, user.house);
      const tomorrowText = getTomorrowString();
      const match = collections.find((d) => d.date === tomorrowText);
      if (!match) return res.send(twiml("No bin collection tomorrow."));
      return res.send(twiml(buildReminder(match)));
    }

    return res.send(twiml("Send HELP for available commands."));
  }

  // ── Onboarding: postcode ───────────────────────────────────────────────────
  if (user.step === "postcode") {
    if (!UK_POSTCODE.test(text)) {
      return res.send(twiml("That doesn't look like a valid postcode.\n\nPlease send your postcode (e.g. DE1 1AA):"));
    }
    user.postcode = text.toUpperCase().replace(/\s+/g, " ").trim();
    user.step = "house";
    saveUsers();
    return res.send(twiml(`Got it 👍

Now send your house number or name:
(e.g. 14  or  Rosewood)`));
  }

  // ── Onboarding: house number/name ─────────────────────────────────────────
  if (user.step === "house") {
    user.house = text.trim();
    user.step = "confirm";
    saveUsers();
    return res.send(twiml(`Got it 👍

Address: ${user.house}, ${user.postcode}

Reply YES to confirm, or send a different postcode to start again.`));
  }

  // ── Onboarding: confirm ───────────────────────────────────────────────────
  if (user.step === "confirm") {
    if (upper === "YES") {
      console.log(`[onboarding] Confirmed: ${from} → ${user.house}, ${user.postcode}`);
      const collections = await getCollections(user.postcode, user.house);
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

    // They sent a new postcode — let them re-enter house number too
    if (UK_POSTCODE.test(text)) {
      user.postcode = text.toUpperCase().replace(/\s+/g, " ").trim();
      user.step = "house";
      saveUsers();
      return res.send(twiml(`Updated 👍

Postcode: ${user.postcode}

Now send your house number or name:`));
    }

    return res.send(twiml(`Reply YES to confirm your address (${user.house}, ${user.postcode}), or send a new postcode to correct it.`));
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

  // Cache per postcode+house to avoid duplicate scrapes
  const cache = {};
  let sent = 0;
  let errors = 0;

  for (const [number, user] of activeUsers) {
    try {
      const cacheKey = `${user.postcode}|${user.house || ""}`;
      if (!cache[cacheKey]) {
        cache[cacheKey] = await getCollections(user.postcode, user.house);
      }

      const match = cache[cacheKey].find((d) => d.date === tomorrowText);

      if (match) {
        await client.messages.create({
          from: process.env.TWILIO_FROM,
          to: number,
          body: buildReminder(match)
        });
        console.log(`[reminders] Sent to ${number} (${user.house}, ${user.postcode}) – ${match.binType}`);
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
  console.log(`V10 Derby Bin Reminder running on port ${PORT}`);
});
