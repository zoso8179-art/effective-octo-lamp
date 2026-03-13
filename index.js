require("dotenv").config();
const { chromium } = require("playwright");
const twilio = require("twilio");

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

function binLabelAndEmoji(binType) {
  const t = (binType || "").toLowerCase();

  if (t.includes("recycl")) {
    return { label: "Recycling", emoji: "🟩" };
  }
  if (t.includes("garden")) {
    return { label: "Garden waste", emoji: "🟫" };
  }
  if (t.includes("food")) {
    return { label: "Food waste", emoji: "🟧" };
  }
  if (t.includes("general") || t.includes("refuse") || t.includes("black")) {
    return { label: "General waste", emoji: "⬛" };
  }

  return { label: "Bin collection", emoji: "🗑️" };
}

function extractBinCollections(bodyText) {
  const text = normaliseText(bodyText);

  // Split into lines so we can inspect nearby text around dates
  const lines = text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dateMatches = line.match(/\b\d{1,2}\s+[a-z]+\s+\d{4}\b/g);

    if (!dateMatches) continue;

    // Look at nearby context to infer bin type
    const context = [
      lines[i - 3] || "",
      lines[i - 2] || "",
      lines[i - 1] || "",
      lines[i] || "",
      lines[i + 1] || "",
      lines[i + 2] || "",
      lines[i + 3] || ""
    ].join(" ");

    let binType = "unknown";

    if (context.match(/recycl/i)) {
      binType = "recycling";
    } else if (context.match(/garden/i)) {
      binType = "garden waste";
    } else if (context.match(/food/i)) {
      binType = "food waste";
    } else if (context.match(/general|refuse|black bin|grey bin|household waste/i)) {
      binType = "general waste";
    }

    for (const date of dateMatches) {
      results.push({
        binType,
        date: date.toLowerCase(),
        context
      });
    }
  }

  // Deduplicate by bin type + date
  const seen = new Set();
  return results.filter(item => {
    const key = `${item.binType}__${item.date}`;
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

      const match = options.find(opt =>
        opt.toLowerCase().includes(ADDRESS_QUERY)
      );

      if (match) {
        matched = true;
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

    console.log("Collections found:", collections);

    const dueTomorrow = collections.find(c => c.date === tomorrowText);

    if (!dueTomorrow) {
      console.log("No reminder needed today.");
      process.exit(0);
    }

    const { label, emoji } = binLabelAndEmoji(dueTomorrow.binType);

    const message = `${emoji} ${label} tomorrow\nPut it out tonight.`;

    await sendReminder(message);
    console.log("Reminder sent:", message);

    process.exit(0);
  } catch (err) {
    console.error("Run failed:", err.message);
    process.exit(1);
  }
}

run();
