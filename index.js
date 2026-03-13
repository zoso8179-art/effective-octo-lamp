require("dotenv").config();
const { chromium } = require("playwright");
const twilio = require("twilio");

console.log("DEBUG VERSION LIVE - PARKFIELDS V2");

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

    // Accept cookies if shown
    const cookieButton = page.getByText("Allow all cookies", { exact: true });
    if (await cookieButton.isVisible().catch(() => false)) {
      await cookieButton.click().catch(() => {});
    }

    // Fill postcode
    const postcodeInput = page.locator("input").first();
    await postcodeInput.fill(POSTCODE);

    // Submit postcode lookup
    await page.getByText("Find Property", { exact: true }).click();
    await page.waitForLoadState("networkidle");

    console.log("Loaded property/results page");

    // Debug dump of page text
    const bodyText1 = (await page.textContent("body")) || "";
    console.log("Page snippet after postcode search:");
    console.log(bodyText1.slice(0, 1000));

    // Try dropdown first
    const selects = page.locator("select");
    const selectCount = await selects.count();

    if (selectCount > 0) {
      console.log(`Found ${selectCount} select element(s)`);

      for (let i = 0; i < selectCount; i++) {
        const select = selects.nth(i);
        const options = await select.locator("option").allTextContents();
        console.log(`Options in select ${i}:`, options);

        const match = options.find(opt =>
          opt.toLowerCase().includes(ADDRESS_QUERY)
        );

        if (match) {
     console.log("Selecting matching property:", match);
await select.selectOption({ label: match });

// submit the form
await page.locator("button, input[type=submit]").first().click();
await page.waitForLoadState("networkidle");
            const optionLocator = select.locator("option");
            const count = await optionLocator.count();
            for (let j = 0; j < count; j++) {
              const txt = (await optionLocator.nth(j).textContent()) || "";
              if (txt.toLowerCase().includes(ADDRESS_QUERY)) {
                const value = await optionLocator.nth(j).getAttribute("value");
                if (value) {
                  await select.selectOption(value);
                  break;
                }
              }
            }
          });
          break;
        }
      }
    } else {
      console.log("No select element found, trying clickable text match");

      const addressLink = page.locator(`text=${ADDRESS_QUERY}`).first();
      if (await addressLink.count()) {
        await addressLink.click().catch(() => {});
      }
    }

    // Click any follow-up button if present
    const buttonsToTry = [
      "Continue",
      "Submit",
      "Find",
      "View",
      "Next"
    ];

    for (const label of buttonsToTry) {
      const btn = page.getByText(label, { exact: true });
      if (await btn.isVisible().catch(() => false)) {
        console.log(`Clicking follow-up button: ${label}`);
        await btn.click().catch(() => {});
        await page.waitForLoadState("networkidle").catch(() => {});
        break;
      }
    }

    const bodyText2 = ((await page.textContent("body")) || "").toLowerCase();
    console.log("Scanning page for collection date...");
    console.log(bodyText2.slice(0, 1500));

    // Collect all date-like strings and use the first one
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
