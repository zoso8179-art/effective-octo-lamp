require("dotenv").config();
const { chromium } = require("playwright");
const twilio = require("twilio");

console.log("DEBUG VERSION LIVE - PARKFIELDS V3");

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

    // Accept cookies if visible
    const allowCookiesBtn = page.locator("#allow-all-cookies");
    if (await allowCookiesBtn.count()) {
      try {
        if (await allowCookiesBtn.isVisible()) {
          console.log("Accepting cookies...");
          await allowCookiesBtn.click();
          await page.waitForTimeout(1000);
        }
      } catch (e) {
        console.log("Cookie button not clicked, continuing...");
      }
    }

    // Enter postcode
    const postcodeInput = page.locator('input[type="text"], input').first();
    await postcodeInput.fill(POSTCODE);

    // Click Find Property
    const findPropertyButton = page
      .locator('input[type="submit"], button')
      .filter({ hasText: /find property/i })
      .first();

    if (await findPropertyButton.count()) {
      await findPropertyButton.click();
    } else {
      // fallback
      await page.keyboard.press("Enter");
    }

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    console.log("Loaded property/results page");

    // Debug dump of page text
    const bodyText1 = (await page.textContent("body")) || "";
    console.log("Page snippet after postcode search:");
    console.log(bodyText1.slice(0, 1000));

    const selects = page.locator("select");
    const selectCount = await selects.count();

    if (selectCount > 0) {
      console.log(`Found ${selectCount} select element(s)`);

      let matched = false;

      for (let i = 0; i < selectCount; i++) {
        const select = selects.nth(i);
        const options = await select.locator("option").allTextContents();
        console.log(`Options in select ${i}:`, options);

        const match = options.find((opt) =>
          opt.toLowerCase().includes(ADDRESS_QUERY)
        );

        if (match) {
          matched = true;
          console.log("Selecting matching property:", match);
          await select.selectOption({ label: match });

          // Submit the form that owns this select
          await Promise.all([
            page.waitForLoadState("domcontentloaded").catch(() => {}),
            select.evaluate((el) => {
              const form = el.closest("form");
              if (form) form.submit();
            })
          ]);

          await page.waitForTimeout(3000);
          console.log("Property form submitted");
          break;
        }
      }

      if (!matched) {
        console.log("No matching property found in dropdown");
        return null;
      }
    } else {
      console.log("No select element found, trying clickable text match");

      const addressLink = page.locator(`text=${ADDRESS_QUERY}`).first();
      if (await addressLink.count()) {
        await addressLink.click();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        console.log("No clickable property match found");
        return null;
      }
    }

    console.log("Current URL after property submit:", page.url());

    const bodyText2 = ((await page.textContent("body")) || "").toLowerCase();
    console.log("Scanning page for collection date...");
    console.log(bodyText2.slice(0, 2000));

    const matches = bodyText2.match(/\b\d{1,2}\s+[a-z]+\s+\d{4}\b/g);
    if (!matches || matches.length === 0) {
      return null;
    }

    console.log("Date candidates found:", matches);
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

    console.log("Next collection:", nextDate);
    console.log("Tomorrow:", tomorrowText);

    if (nextDate.toLowerCase().includes(tomorrowText)) {
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
    console.error(err);
    process.exit(1);
  }
}

run();
