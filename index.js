const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const users = {}; // simple in-memory store

// -----------------------------
// HEALTH
// -----------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "Derby Bin Reminder",
    timezone: "Europe/London",
    reminder_time: "18:00",
    onboarding_model: "postcode + house number",
    sandbox_join_phrase: "join path-avoid"
  });
});

// -----------------------------
// ROOT
// -----------------------------
app.get("/", (req, res) => {
  res.send("Derby Bin Reminder is running");
});

// -----------------------------
// FETCH BINS
// -----------------------------
async function getCollections(postcode) {
  const url = `https://www.derby.gov.uk/bins-and-recycling/bin-collections/?postcode=${encodeURIComponent(
    postcode
  )}`;

  const response = await axios.get(url);
  const $ = cheerio.load(response.data);

  const text = $("body").text().toLowerCase();

  const regex =
    /(\d{1,2} \w+ \d{4}): (general waste|recycling|garden|food).*?collection/g;

  const matches = [...text.matchAll(regex)];

  return matches.map((m) => ({
    date: m[1],
    binType: m[2]
  }));
}

// -----------------------------
// FORMAT MESSAGE
// -----------------------------
function buildMessage(collection) {
  const icons = {
    recycling: "🔵",
    "general waste": "⚫",
    garden: "🟤",
    food: "🟢"
  };

  return `Reminder for tomorrow:\n${icons[collection.binType] || ""} ${
    collection.binType
  } bin`;
}

// -----------------------------
// WHATSAPP WEBHOOK
// -----------------------------
app.post("/whatsapp", async (req, res) => {
  const incoming = req.body.Body.trim();
  const from = req.body.From;

  if (!users[from]) {
    users[from] = { step: "postcode" };
    return res.send(
      `<Response><Message>Never forget bin day again.\n\nEnter your postcode and house number:\nExample: DE22 1HH 14</Message></Response>`
    );
  }

  const user = users[from];

  // STEP: POSTCODE INPUT
  if (user.step === "postcode") {
    const parts = incoming.split(" ");
    user.postcode = parts.slice(0, 2).join(" ");
    user.step = "done";

    return res.send(
      `<Response><Message>You're set.\n\nYou'll get a reminder at 18:00 the evening before collection.</Message></Response>`
    );
  }

  // COMMANDS
  if (incoming.toUpperCase() === "NEXT") {
    const data = await getCollections(user.postcode);
    return res.send(
      `<Response><Message>Next collection:\n${data[0].date} - ${data[0].binType}</Message></Response>`
    );
  }

  if (incoming.toUpperCase() === "STOP") {
    user.paused = true;
    return res.send(
      `<Response><Message>Reminders paused. Send START to resume.</Message></Response>`
    );
  }

  if (incoming.toUpperCase() === "START") {
    user.paused = false;
    return res.send(
      `<Response><Message>Reminders resumed.</Message></Response>`
    );
  }

  res.send(
    `<Response><Message>Commands:\nNEXT\nSTOP\nSTART</Message></Response>`
  );
});

// -----------------------------
// SEND REMINDER
// -----------------------------
async function sendReminder(to, message) {
  await client.messages.create({
    from: process.env.TWILIO_FROM,
    to,
    body: message
  });
}

// -----------------------------
// RUN REMINDERS
// -----------------------------
app.get("/run-reminders", async (req, res) => {
  if (req.query.key !== process.env.RUN_KEY) {
    return res.status(403).send("Forbidden");
  }

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const tomorrowText = tomorrow
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "long",
      year: "numeric"
    })
    .toLowerCase();

  const markerFile = "/tmp/lastReminder.txt";

  for (const number in users) {
    const user = users[number];

    if (user.paused) continue;

    const data = await getCollections(user.postcode);

    const match = data.find((d) => d.date === tomorrowText);

    if (match) {
      if (fs.existsSync(markerFile)) {
        const last = fs.readFileSync(markerFile, "utf8");
        if (last === tomorrowText) continue;
      }

      const msg = buildMessage(match);
      await sendReminder(number, msg);
      fs.writeFileSync(markerFile, tomorrowText);
    }
  }

  res.json({ ok: true });
});

// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Derby Bin Bot listening on", PORT);
});
