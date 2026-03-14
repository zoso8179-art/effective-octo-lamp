function normalizeText(text) {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim()
    .toLowerCase();
}

function titleCase(text) {
  return (text || "").replace(/\b\w/g, c => c.toUpperCase());
}

function normalizeWhatsApp(value) {
  if (!value) return "";
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

function parseQuickSetup(text) {
  const input = (text || "").trim();
  const postcodeRegex = /\b([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i;
  const match = input.match(postcodeRegex);
  if (!match) return null;

  const rawPostcode = match[1].toUpperCase().replace(/\s+/g, "");
  const postcode = rawPostcode.replace(/^(.+)(.{3})$/, "$1 $2");
  let remainder = input.replace(match[0], "").trim();
  remainder = remainder.replace(/^,+/, "").trim();

  if (!remainder) return { postcode, query: "", type: "postcode_only" };
  return { postcode, query: remainder, type: "postcode_plus_query" };
}

function isLikelyNumericQuery(text) {
  return /^\d+[A-Z]?$/.test((text || "").trim().toUpperCase());
}

function propertyMatchesQuery(optionText, query) {
  const option = String(optionText || "").toLowerCase();
  const q = (query || "").trim().toLowerCase();
  if (!q) return false;

  if (isLikelyNumericQuery(q.toUpperCase())) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`\\b${escaped}\\b`, "i"),
      new RegExp(`,\\s*${escaped}\\b`, "i"),
      new RegExp(`\\b${escaped},`, "i")
    ];
    return patterns.some(rx => rx.test(optionText));
  }

  return option.includes(q);
}

module.exports = {
  normalizeText,
  titleCase,
  normalizeWhatsApp,
  parseQuickSetup,
  isLikelyNumericQuery,
  propertyMatchesQuery
};
