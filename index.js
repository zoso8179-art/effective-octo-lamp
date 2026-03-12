require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const twilio = require('twilio');

const ADDRESS_QUERY = (process.env.ADDRESS_QUERY || "").toLowerCase().trim();
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function lookupBinDay() {
  const url = "https://secure.derby.gov.uk/binday/";
  console.log("Checking Derby bin day page...");

  const res = await axios.get(url);
  const $ = cheerio.load(res.data);

  let nextDate = null;

  $("table tr").each((i, el) => {
    const row = $(el).text().toLowerCase();
    if (row.includes(ADDRESS_QUERY)) {
      const match = row.match(/\d{1,2}\s+[a-z]+\s+\d{4}/);
      if (match) {
        nextDate = match[0];
      }
    }
  });

  return nextDate;
}

async function sendReminder(msg) {
  await client.messages.create({
    from: process.env.TWILIO_FROM,
    to: process.env.TWILIO_TO,
    body: msg
  });
}

async function run() {
  try {
    const nextDate = await lookupBinDay();

    if (!nextDate) {
      console.log("Could not determine bin date.");
      process.exit(1);
    }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const tomorrowText = tomorrow.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric"
    });

    console.log("Next collection:", nextDate);
    console.log("Tomorrow:", tomorrowText);

    if (nextDate.toLowerCase().includes(tomorrowText.toLowerCase())) {
      await sendReminder("Reminder: your bin collection is tomorrow. Put the bins out tonight.");
      console.log("Reminder sent.");
    } else {
      console.log("No reminder needed today.");
    }

    process.exit(0);
  } catch (err) {
    console.error("Run failed:", err.message);
    process.exit(1);
  }
}

run();
