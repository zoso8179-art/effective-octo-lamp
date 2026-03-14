const { parseQuickSetup, propertyMatchesQuery } = require("../utils/text");

class OnboardingService {
  constructor(councilRouter, replyBuilder, env) {
    this.councilRouter = councilRouter;
    this.replyBuilder = replyBuilder;
    this.env = env;
  }

  async handleInput(user, body) {
    if (user.state === "awaiting_address_confirmation") {
      return this.handleConfirmation(user, body);
    }

    const parsed = parseQuickSetup(body);
    if (!parsed) return this.replyBuilder.askForRetry();

    user.postcode = parsed.postcode;

    if (parsed.type === "postcode_only") {
      user.state = "awaiting_postcode_or_address";
      return this.replyBuilder.askForMoreDetail();
    }

    const adapter = this.councilRouter.getAdapter(user.councilId);
    const options = await adapter.searchAddresses(parsed.postcode);
    const matches = options.filter(option => propertyMatchesQuery(option, parsed.query));

    if (matches.length === 0) {
      user.state = "awaiting_postcode_or_address";
      return this.replyBuilder.askForRetry();
    }

    if (matches.length === 1) {
      user.pendingMatches = [matches[0]];
      user.state = "awaiting_address_confirmation";
      return this.replyBuilder.confirmAddressOne(matches[0]);
    }

    user.pendingMatches = matches.slice(0, 5);
    user.state = "awaiting_address_confirmation";
    return this.replyBuilder.multiMatch(user.pendingMatches);
  }

  async handleConfirmation(user, body) {
    const upper = (body || "").trim().toUpperCase();

    if (upper === "NO") {
      user.pendingMatches = [];
      user.state = "awaiting_postcode_or_address";
      return ["No problem.", "", "Please send your postcode and house number again.", "", "Example:", "DE22 1HH 14"].join("\n");
    }

    let chosen = null;
    if (upper === "YES" && user.pendingMatches.length === 1) {
      chosen = user.pendingMatches[0];
    } else {
      const numeric = parseInt((body || "").trim(), 10);
      if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= user.pendingMatches.length) {
        chosen = user.pendingMatches[numeric - 1];
      }
    }

    if (!chosen) {
      return "Please reply YES to confirm, NO to try again, or send the number of the correct address.";
    }

    user.addressQuery = chosen;
    user.label = chosen;
    user.pendingMatches = [];
    user.state = "complete";
    user.paused = false;
    user.updatedAt = new Date().toISOString();

    const adapter = this.councilRouter.getAdapter(user.councilId);
    const collections = await adapter.getSchedule(user.postcode, user.addressQuery);
    const nextCollection = collections.length ? collections[0] : null;

    return this.replyBuilder.subscriptionConfirmed(user, this.env.REMINDER_TIME_TEXT, nextCollection);
  }
}

module.exports = OnboardingService;
