const { parseQuickSetup } = require("../utils/text");
const { getTomorrowText } = require("../utils/dates");

class MessageHandler {
  constructor(userStore, onboardingService, councilRouter, replyBuilder, env) {
    this.userStore = userStore;
    this.onboardingService = onboardingService;
    this.councilRouter = councilRouter;
    this.replyBuilder = replyBuilder;
    this.env = env;
  }

  async handle(from, bodyRaw) {
    const body = (bodyRaw || "").trim();
    const upper = body.toUpperCase();

    const store = this.userStore.load();
    const user = this.userStore.getOrCreateUser(store, from);

    if (upper === "STOP") {
      user.paused = true;
      user.updatedAt = new Date().toISOString();
      this.userStore.save(store);
      return this.replyBuilder.paused();
    }

    if (upper === "START") {
      user.paused = false;
      user.updatedAt = new Date().toISOString();
      if (!user.postcode || !user.addressQuery) {
        user.state = "awaiting_postcode_or_address";
        user.pendingMatches = [];
        this.userStore.save(store);
        return this.replyBuilder.welcome(this.env.APP_NAME, this.env.REMINDER_TIME_TEXT);
      }
      user.state = "complete";
      this.userStore.save(store);
      return this.replyBuilder.restarted(this.env.REMINDER_TIME_TEXT);
    }

    if (upper === "HELP") {
      return this.replyBuilder.help(this.env.APP_NAME);
    }

    if (upper === "NEXT") {
      if (!user.postcode || !user.addressQuery) return this.replyBuilder.defaultReply(this.env.APP_NAME);
      const adapter = this.councilRouter.getAdapter(user.councilId);
      const collections = await adapter.getSchedule(user.postcode, user.addressQuery);
      if (!collections.length) return "I couldn’t find your collection details right now.";
      return this.replyBuilder.nextCollection(this.env.APP_NAME, user.label || user.addressQuery, collections[0]);
    }

    if (upper === "TOMORROW") {
      if (!user.postcode || !user.addressQuery) return this.replyBuilder.defaultReply(this.env.APP_NAME);
      const adapter = this.councilRouter.getAdapter(user.councilId);
      const collections = await adapter.getSchedule(user.postcode, user.addressQuery);
      if (!collections.length) return "I couldn’t find your collection details right now.";
      const tomorrowText = getTomorrowText(this.env.TIMEZONE);
      const dueTomorrow = collections.filter(c => c.date === tomorrowText);
      if (!dueTomorrow.length) return this.replyBuilder.noTomorrow();
      return this.replyBuilder.tomorrowCollection(this.env.APP_NAME, user.label || user.addressQuery, dueTomorrow);
    }

    if (upper === "JOIN") {
      user.state = "awaiting_postcode_or_address";
      user.paused = false;
      user.pendingMatches = [];
      user.updatedAt = new Date().toISOString();
      this.userStore.save(store);
      return this.replyBuilder.welcome(this.env.APP_NAME, this.env.REMINDER_TIME_TEXT);
    }

    if (user.state === "awaiting_postcode_or_address" || user.state === "awaiting_address_confirmation") {
      const reply = await this.onboardingService.handleInput(user, body);
      user.updatedAt = new Date().toISOString();
      this.userStore.save(store);
      return reply;
    }

    if (parseQuickSetup(body)) {
      user.state = "awaiting_postcode_or_address";
      user.paused = false;
      user.pendingMatches = [];
      const reply = await this.onboardingService.handleInput(user, body);
      user.updatedAt = new Date().toISOString();
      this.userStore.save(store);
      return reply;
    }

    return this.replyBuilder.defaultReply(this.env.APP_NAME);
  }
}

module.exports = MessageHandler;
