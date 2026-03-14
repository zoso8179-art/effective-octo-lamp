const { chromium } = require("playwright");
const { normalizeText, propertyMatchesQuery } = require("../utils/text");

function classifyBinType(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("general waste") || t.includes("black bin")) return "general waste";
  if (t.includes("recycling") || t.includes("blue bin")) return "recycling";
  if (t.includes("garden") || t.includes("brown bin")) return "garden waste";
  if (t.includes("food waste")) return "food waste";
  return "unknown";
}

function extractBinCollections(bodyText) {
  const text = normalizeText(bodyText);
  const pattern =
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s+(\d{1,2}\s+[a-z]+\s+\d{4})\s*:\s*([a-z ]+?bin collection)\b/gi;

  const results = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const date = match[1].toLowerCase().trim();
    const description = match[2].toLowerCase().trim();
    results.push({ date, binType: classifyBinType(description), description });
  }

  const seen = new Set();
  return results.filter(item => {
    const key = `${item.date}__${item.binType}__${item.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function withPage(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function openPropertyPage(page, postcode) {
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
    } catch (_) {}
  }

  const postcodeInput = page.locator('input[type="text"], input').first();
  await postcodeInput.fill(postcode);

  const findBtn = page.locator('input[type="submit"], button').filter({ hasText: /find property/i }).first();
  if (await findBtn.count()) await findBtn.click();
  else await page.keyboard.press("Enter");

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);
}

async function searchAddresses(postcode) {
  return withPage(async (page) => {
    await openPropertyPage(page, postcode);

    const selects = page.locator("select");
    const selectCount = await selects.count();
    if (selectCount === 0) return [];

    for (let i = 0; i < selectCount; i++) {
      const select = selects.nth(i);
      const options = await select.locator("option").allTextContents();
      const cleaned = options.map(o => o.trim()).filter(o => o && !o.toLowerCase().includes("select premises"));
      if (cleaned.length) return cleaned;
    }
    return [];
  });
}

async function getSchedule(postcode, addressQuery) {
  return withPage(async (page) => {
    await openPropertyPage(page, postcode);

    const selects = page.locator("select");
    const selectCount = await selects.count();
    if (selectCount === 0) return [];

    let matched = false;
    for (let i = 0; i < selectCount; i++) {
      const select = selects.nth(i);
      const options = await select.locator("option").allTextContents();
      const chosen = options.find(opt => propertyMatchesQuery(opt, addressQuery));

      if (chosen) {
        matched = true;
        await select.selectOption({ label: chosen });
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
  });
}

module.exports = {
  id: "derby",
  searchAddresses,
  getSchedule
};
