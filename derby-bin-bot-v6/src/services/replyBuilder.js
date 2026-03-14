const { titleCase } = require("../utils/text");

function binLabelAndEmoji(binType) {
  const t = (binType || "").toLowerCase();
  if (t.includes("recycl")) return { label: "Blue bin – Recycling", emoji: "🟦" };
  if (t.includes("garden")) return { label: "Brown bin – Garden waste", emoji: "🟫" };
  if (t.includes("food")) return { label: "Green bin – Food waste", emoji: "🟩" };
  if (t.includes("general") || t.includes("black")) return { label: "Black bin – General waste", emoji: "⬛" };
  return { label: "Bin collection", emoji: "🗑️" };
}

module.exports = {
  binLabelAndEmoji,
  welcome(appName, reminderTimeText) {
    return [
      "Hi 👋",
      "",
      `I’m the ${appName}.`,
      `I’ll send you a WhatsApp message at ${reminderTimeText} the evening before your bin collection.`,
      "",
      "Send your postcode and house number in one message.",
      "",
      "Example:",
      "DE22 1HH 14"
    ].join("\n");
  },
  askForRetry() {
    return ["I couldn’t match that address.", "", "Please send your postcode and house number again.", "", "Example:", "DE22 1HH 14"].join("\n");
  },
  askForMoreDetail() {
    return ["Thanks.", "", "Now send your house number or house number and street name.", "", "Examples:", "14", "14 Parkfields Drive"].join("\n");
  },
  multiMatch(matches) {
    return ["I found more than one possible match.", "", ...matches.map((m, i) => `${i + 1}. ${m}`), "", "Reply with the number of the correct address."].join("\n");
  },
  confirmAddressOne(address) {
    return ["I found this address:", "", address, "", "Reply YES to confirm, or NO to try again."].join("\n");
  },
  subscriptionConfirmed(user, reminderTimeText, nextCollection) {
    const lines = [
      "Perfect 👍",
      "",
      "You’re now subscribed for:",
      `${user.label}, Derby`,
      "",
      `I’ll remind you at ${reminderTimeText} the evening before collection.`
    ];
    if (nextCollection) {
      const info = binLabelAndEmoji(nextCollection.binType);
      lines.push("", "Next collection:", `${info.emoji} ${info.label}`, `${titleCase(nextCollection.date)}`);
    }
    lines.push("", "If this reminder is useful, feel free to share it with neighbours in Derby 👍", "", "Text NEXT for your next bin day.", "Text TOMORROW to check tomorrow’s bin.", "Text STOP to pause reminders.");
    return lines.join("\n");
  },
  nextCollection(appName, label, collection) {
    const info = binLabelAndEmoji(collection.binType);
    return [`🗑️ ${appName}`, "", `Address: ${label}`, `${info.emoji} ${info.label}`, `Next: ${titleCase(collection.date)}`].join("\n");
  },
  tomorrowCollection(appName, label, dueTomorrow) {
    const lines = [`🗑️ ${appName}`, "", `Address: ${label}`, "", "Tomorrow is:"];
    dueTomorrow.forEach(item => {
      const info = binLabelAndEmoji(item.binType);
      lines.push(`${info.emoji} ${info.label}`);
    });
    lines.push("", "Put it out tonight 👍");
    return lines.join("\n");
  },
  noTomorrow() {
    return "There isn't a bin collection tomorrow based on the latest schedule I found.";
  },
  paused() {
    return ["Reminders paused.", "", "Text START anytime to turn them back on."].join("\n");
  },
  restarted(reminderTimeText) {
    return ["You’re back on 👍", "", `I’ll remind you at ${reminderTimeText} the evening before collection.`].join("\n");
  },
  help(appName) {
    return [`🗑️ ${appName}`, "", "Commands:", "NEXT - next bin collection", "TOMORROW - check tomorrow’s bin", "STOP - pause reminders", "START - resume reminders", "HELP - show this help"].join("\n");
  },
  defaultReply(appName) {
    return ["Hi 👋", "", `Welcome to ${appName}.`, "Send your postcode and house number.", "", "Example:", "DE22 1HH 14"].join("\n");
  },
  reminderMessage(appName, label, dueTomorrow, upcoming) {
    const dueLines = dueTomorrow.map(item => {
      const info = binLabelAndEmoji(item.binType);
      return `${info.emoji} ${info.label}`;
    });
    const upcomingLines = upcoming.slice(0, 3).map(item => {
      const info = binLabelAndEmoji(item.binType);
      return `${info.emoji} ${info.label} – ${titleCase(item.date)}`;
    });
    return [`🗑️ ${appName}`, "", label ? `Address: ${label}` : null, ...dueLines, "", "Tomorrow", "Put it out tonight.", upcomingLines.length ? "" : null, upcomingLines.length ? "Coming up:" : null, ...upcomingLines].filter(Boolean).join("\n");
  }
};
