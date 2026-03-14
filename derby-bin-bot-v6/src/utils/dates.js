function getTomorrowText(timezone) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: timezone
  }).toLowerCase();
}

function todayKey(timezone) {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
}

module.exports = { getTomorrowText, todayKey };
