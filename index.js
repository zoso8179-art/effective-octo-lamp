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
    await page.goto("https://secure.derby.gov.uk/binday/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Accept cookies if shown
    const cookieBtn = page.locator("#allow-all-cookies");
    if (await cookieBtn.count()) {
      try {
        if (await cookieBtn.isVisible()) {
          await cookieBtn.click();
          await page.waitForTimeout(500);
        }
      } catch {}
    }

    // Enter postcode
    const postcodeInput = page.locator('input[type="text"], input').first();
    await postcodeInput.fill(POSTCODE);

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

    if (selectCount === 0) return null;

    for (let i = 0; i < selectCount; i++) {
      const select = selects.nth(i);
      const options = await select.locator("option").allTextContents();

      const match = options.find(opt =>
        opt.toLowerCase().includes(ADDRESS_QUERY)
      );

      if (match) {
        await select.selectOption({ label: match });

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

    const bodyText = ((await page.textContent("body")) || "").toLowerCase();

    const matches = bodyText.match(/\b\d{1,2}\s+[a-z]+\s+\d{4}\b/g);
    if (!matches || matches.length === 0) return null;

    return matches[0];
  } finally {
    await browser.close();
  }
}

async function sendReminder(message) {
  await client.messages.create({
    from: process.env.TWILIO_FROM,
    to: process.env.TWILIO_TO,
    body: message
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

    const tomorrowText = tomorrow
      .toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric"
      })
      .toLowerCase();

    if (nextDate.includes(tomorrowText)) {
      await sendReminder(
        "Reminder: your bin collection is tomorrow. Put your bins out tonight."
      );
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
