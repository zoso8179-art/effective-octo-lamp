const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const twilio = require("twilio");
const { Pool } = require("pg");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

// ── Database setup ──────────────────────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function setupDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
              phone       TEXT PRIMARY KEY,
                    step        TEXT NOT NULL DEFAULT 'postcode',
                          postcode    TEXT,
                                house       TEXT,
                                      paused      BOOLEAN NOT NULL DEFAULT false,
                                            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                                  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
                                                      )
                                                        `);
    console.log("[db] Table ready");
}

async function getUser(phone) {
    const r = await pool.query("SELECT * FROM users WHERE phone = $1", [phone]);
    return r.rows[0] || null;
}

async function saveUser(phone, data) {
    await pool.query(`
        INSERT INTO users (phone, step, postcode, house, paused, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT (phone) DO UPDATE SET
                      step       = EXCLUDED.step,
                            postcode   = EXCLUDED.postcode,
                                  house      = EXCLUDED.house,
                                        paused     = EXCLUDED.paused,
                                              updated_at = NOW()
                                                `, [phone, data.step, data.postcode || null, data.house || null, data.paused || false]);
}

async function deleteUser(phone) {
    await pool.query("DELETE FROM users WHERE phone = $1", [phone]);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function twiml(text) {
    return `<Response><Message>${text}</Message></Response>`;
}

function buildReminder(bin) {
    const icons = {
          recycling: "🔵",
          "general waste": "⚫",
          garden: "🟤",
          food: "🟢"
    };
    return `🗑️ Bin Reminder

    Tomorrow:
    ${icons[bin.binType] || "🗑️"} ${bin.binType}

    Put it out tonight 👍`;
}

// ── Scraper (Derby Council two-step UPRN API) ────────────────────────────────
async function getCollections(postcode, house) {
    const axiosOpts = {
          timeout: 10000,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; BinReminderBot/10.0)" }
    };

  const cleanPostcode = postcode.replace(/\s+/g, "").toUpperCase();
    const step1Url = `https://secure.derby.gov.uk/binday/SelectProperty?postcode=${encodeURIComponent(cleanPostcode)}`;
    console.log(`[scraper] Step 1: ${step1Url}`);

  const step1 = await axios.get(step1Url, axiosOpts);
    const $1 = cheerio.load(step1.data);

  let uprn = null;
    let selectedAddress = null;

  $1("select option").each((_, el) => {
        const val = $1(el).attr("value");
        const label = $1(el).text().trim();
        if (!val) return;
        if (house && label.toLowerCase().includes(house.toLowerCase())) {
                uprn = val;
                selectedAddress = label;
        }
        if (!uprn) {
                uprn = val;
                selectedAddress = label;
        }
  });

  if (!uprn) throw new Error("No properties found for postcode");

  console.log(`[scraper] Using UPRN ${uprn} -> ${selectedAddress}`);

  const step2Url = `https://secure.derby.gov.uk/binday/BinDays/${uprn}?address=${encodeURIComponent(selectedAddress)}`;
    console.log(`[scraper] Step 2: ${step2Url}`);

  const step2 = await axios.get(step2Url, axiosOpts);
    const $2 = cheerio.load(step2.data);

  const collections = [];
    $2(".binresult, .bin-result, [class*='bin']").each((_, el) => {
          const text = $2(el).text().trim().toLowerCase();
          const dateMatch = text.match(/(\d{1,2}\s+\w+\s+\d{4})/);
          const typeMatch = text.match(/(general waste|recycling|garden|food)/i);
          if (dateMatch && typeMatch) {
                  collections.push({
                            date: dateMatch[1],
                            binType: typeMatch[1].toLowerCase()
                  });
          }
    });

  console.log(`[scraper] ${cleanPostcode} "${house}" -> ${collections.length} collection(s) found`);
    return collections;
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
    res.send("V11 Binday is running");
});

app.get("/health", async (req, res) => {
    const r = await pool.query("SELECT COUNT(*) FROM users WHERE step = 'active'");
    const total = await pool.query("SELECT COUNT(*) FROM users");
    res.json({
          ok: true,
          version: "v11",
          app: "Binday",
          timezone: "Europe/London",
          reminder_time: "18:00",
          active_users: parseInt(r.rows[0].count),
          total_users: parseInt(total.rows[0].count)
    });
});

app.post("/whatsapp", async (req, res) => {
    const text = (req.body.Body || "").trim();
    const from = req.body.From;
    const upper = text.toUpperCase();

           if (upper === "STOP") {
                 const user = await getUser(from);
                 if (user) await saveUser(from, { ...user, paused: true });
                 return res.send(twiml("Reminders paused. Send START to resume."));
           }

           if (upper === "START") {
                 const user = await getUser(from);
                 if (user) await saveUser(from, { ...user, paused: false });
                 return res.send(twiml("Reminders resumed 👍"));
           }

           if (upper === "RESET") {
                 await deleteUser(from);
                 return res.send(twiml("Cleared. Send your postcode to start again."));
           }

           if (upper === "HELP") {
                 return res.send(twiml(`Commands:
                 NEXT - next collection
                 TOMORROW - is there a collection tomorrow?
                 STOP - pause reminders
                 START - resume reminders
                 RESET - start over`));
           }

           let user = await getUser(from);

           if (!user) {
                 await saveUser(from, { step: "postcode", paused: false });
                 return res.send(twiml(`Binday

                 Never miss bin day again.

                 Send your postcode:`));
           }

           if (user.step === "postcode") {
                 await saveUser(from, { ...user, step: "house", postcode: text.toUpperCase() });
                 return res.send(twiml(`Got it

                 Now send your house number:`));
           }

           if (user.step === "house") {
                 await saveUser(from, { ...user, step: "confirm", house: text });
                 return res.send(twiml(`Found:
                 ${text} ${user.postcode}

                 Reply YES to confirm`));
           }

           if (user.step === "confirm") {
                 if (upper !== "YES") {
                         return res.send(twiml("Reply YES to confirm, or RESET to start over."));
                 }
                 await saveUser(from, { ...user, step: "active" });

      let nextLine = "";
                 try {
                         const collections = await getCollections(user.postcode, user.house);
                         if (collections.length) {
                                   nextLine = `\nNext collection:\n${collections[0].date} - ${collections[0].binType}`;
                         }
                 } catch (e) {
                         console.error("[confirm] scraper error:", e.message);
                 }

      return res.send(twiml(`You're set${nextLine}

      You'll get a reminder at 18:00 the night before collection.

      Reply HELP anytime.`));
           }

           if (upper === "NEXT") {
                 try {
                         const collections = await getCollections(user.postcode, user.house);
                         if (!collections.length) return res.send(twiml("I couldn't find your next collection right now. Try again later."));
                         return res.send(twiml(`Next:\n${collections[0].date} - ${collections[0].binType}`));
                 } catch (e) {
                         return res.send(twiml("Couldn't reach Derby Council right now. Try again in a few minutes."));
                 }
           }

           if (upper === "TOMORROW") {
                 try {
                         const collections = await getCollections(user.postcode, user.house);
                         const tomorrow = new Date();
                         tomorrow.setDate(tomorrow.getDate() + 1);
                         const tomorrowText = tomorrow.toLocaleDateString("en-GB", {
                                   day: "numeric", month: "long", year: "numeric"
                         }).toLowerCase();

                   const match = collections.find(d => d.date === tomorrowText);
                         if (!match) return res.send(twiml("No bin collection tomorrow."));
                         return res.send(twiml(buildReminder(match)));
                 } catch (e) {
                         return res.send(twiml("Couldn't reach Derby Council right now. Try again in a few minutes."));
                 }
           }

           return res.send(twiml("Send HELP for available commands."));
});

// ── Nightly reminder job ─────────────────────────────────────────────────────
app.get("/run-reminders", async (req, res) => {
    if (req.query.key !== process.env.RUN_KEY) {
          return res.status(403).send("Forbidden");
    }

          const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowText = tomorrow.toLocaleDateString("en-GB", {
          day: "numeric", month: "long", year: "numeric"
    }).toLowerCase();

          const { rows } = await pool.query(
                "SELECT * FROM users WHERE step = 'active' AND paused = false"
              );

          let sent = 0;
    for (const user of rows) {
          try {
                  const collections = await getCollections(user.postcode, user.house);
                  const match = collections.find(d => d.date === tomorrowText);
                  if (match) {
                            await client.messages.create({
                                        from: process.env.TWILIO_FROM,
                                        to: user.phone,
                                        body: buildReminder(match)
                            });
                            sent++;
                  }
          } catch (e) {
                  console.error(`[reminders] error for ${user.phone}:`, e.message);
          }
    }

          res.json({ ok: true, checked: rows.length, sent });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
setupDb().then(() => {
    app.listen(PORT, () => console.log(`V11 Binday running on port ${PORT}`));
});
