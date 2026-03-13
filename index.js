require("dotenv").config();
const { chromium } = require("playwright");
const twilio = require("twilio");

console.log("DEBUG VERSION LIVE - PARKFIELDS V4");

const POSTCODE = (process.env.POSTCODE || "").trim();
const ADDRESS_QUERY = (process.env.ADDRESS_QUERY || "").toLowerCase().trim();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

function normaliseText(text) {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim()
    .toLowerCase();
}

function getTomorrowText() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  return tomorrow
    .toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric"
    })
    .toLowerCase();
}

function classifyBinType(text) {
  const t = (text || "").toLowerCase();

  if (t.includes("general waste") || t.includes("black bin")) {
    return "general waste";
  }
  if (t.includes("recycling") || t.includes("blue bin")) {
    return "recycling";
  }
  if (t.includes("garden") || t.includes("brown bin")) {
    return "garden waste";
  }
  if (t.includes("food waste")) {
    return "food waste";
  }

  return "unknown";
}

function binLabelAndEmoji(binType) {
  const t = (binType || "").toLowerCase();

  if (t.includes("recycl")) {
    return { label: "Recycling", emoji: "🟦" };
  }
  if (t.includes("garden")) {
    return { label: "Garden waste", emoji: "🟫" };
  }
  if (t.includes("food")) {
    return { label: "Food waste", emoji: "🟩" };
  }
  if (t.includes("general") || t.includes("black")) {
    return { label: "General waste", emoji: "⬛" };
  }

  return { label: "Bin collection", emoji: "🗑️" };
}

function extractBinCollections(bodyText) {
  const text = normaliseText(bodyText);

  const pattern =
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s+(\d{1,2}\s+[a-z]+\s+\d{4})\s*:\s*([a-z ]+?bin collection)\b/gi;

  const results = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const date = match[1].toLowerCase().trim();
    const description = match[2].toLowerCase().trim();
    const binType = classifyBinType(description);

    results.push({
      date,
      binType,
      description
    });
  }

  const seen = new Set();
  return results.filter(item => {
    const key = `${item.date}__${item.binType}__${item.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function lookupBinCollections() {
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

    if (selectCount === 0) return [];

    let matched = false;

    for (let i = 0; i < selectCount; i++) {
      const select = selects.nth(i);
      const options = await select.locator("option").allTextContents();

      const selectedMatch = options.find(opt =>
        opt.toLowerCase().includes(ADDRESS_QUERY)
      );

      if (selectedMatch) {
        matched = true;
        await select.selectOption({ label: selectedMatch });

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

    if (!matched) return [];

    const bodyText = (await page.textContent("body")) || "";
    return extractBinCollections(bodyText);
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
    const tomorrowText = getTomorrowText();
    const collections = await lookupBinCollections();

    if (!collections.length) {
      console.log("Could not determine bin collections.");
      process.exit(1);
    }

    const dueTomorrow = collections.slice(0, 1);

    if (!dueTomorrow.length) {
      console.log("No reminder needed today.");
      process.exit(0);
    }

    const messageLines = dueTomorrow.map(item => {
      const { label, emoji } = binLabelAndEmoji(item.binType);
      return `${emoji} ${label}`;
    });

    const message =
      `🗑️ Derby Bin Reminder\n\n` +
      `${messageLines.join("\n")}\n\n` +
      `Tomorrow\n` +
      `Put it out tonight.`;

    await sendReminder(message);
    console.log("Reminder sent.");
    process.exit(0);
  } catch (err) {
    console.error("Run failed:", err.message);
    process.exit(1);
  }
}
run();
