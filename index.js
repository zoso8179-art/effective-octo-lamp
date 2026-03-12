require("dotenv").config();
const { chromium } = require("playwright");
const twilio = require("twilio");

const POSTCODE = (process.env.POSTCODE || "").trim();
const ADDRESS_QUERY = (process.env.ADDRESS_QUERY || "").toLowerCase().trim();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function lookupBinDay() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    console.log("Opening Derby bin day page...");
    await page.goto("https://secure.derby.gov.uk/binday/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Accept cookies if present
    const allowCookies = page.getByText("Allow all cookies", { exact: true });
    if (await allowCookies.isVisible().catch(() => false)) {
      await allowCookies.click().catch(() => {});
    }

    // Fill postcode
    const postcodeInput = page.locator('input').first();
    await postcodeInput.fill(POSTCODE);

    // Click Find Property
    await page.getByText("Find Property", { exact: true }).click();

    // Wait for address options to appear
    await page.waitForLoadState("networkidle");

    // Try to select the address containing ADDRESS_QUERY
    const pageText = (await page.textContent("body")) || "";
    console.log("Loaded property/results page");

    const matchingOption = page.locator(`text=${ADDRESS_QUERY}`);
    const count = await matchingOption.count().catch(() => 0);

    if (count > 0) {
      await matchingOption.first().click().catch(() => {});
      await page.waitForLoadState("networkidle");
    }

    const bodyText = ((await page.textContent("body")) || "").toLowerCase();
    console.log("Scanning page for collection date...");

    const dateMatch = bodyText.match(/\b\d{1,2}\s+[a-z]+\s+\d{4}\b/);
    if (!dateMatch) {
      return null;
    }

    return dateMatch[0];
  } finally {
    await browser.close();
  }
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
    }).toLowerCase();

    console.log("Next collection:", nextDate);
    console.log("Tomorrow:", tomorrowText);

    if (nextDate.includes(tomorrowText)) {
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

run();
