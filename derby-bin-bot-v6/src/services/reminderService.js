const { getTomorrowText, todayKey } = require("../utils/dates");

class ReminderService {
  constructor(userStore, councilRouter, messageService, replyBuilder, env) {
    this.userStore = userStore;
    this.councilRouter = councilRouter;
    this.messageService = messageService;
    this.replyBuilder = replyBuilder;
    this.env = env;
  }

  async run() {
    const store = this.userStore.load();
    const tomorrowText = getTomorrowText(this.env.TIMEZONE);
    const markerDay = todayKey(this.env.TIMEZONE);

    for (const phone of Object.keys(store.users)) {
      const user = store.users[phone];
      if (user.paused) continue;
      if (user.state !== "complete") continue;
      if (!user.postcode || !user.addressQuery) continue;

      const sentKey = `${phone}__${markerDay}`;
      if (store.sent[sentKey]) continue;

      const adapter = this.councilRouter.getAdapter(user.councilId);
      const collections = await adapter.getSchedule(user.postcode, user.addressQuery);
      if (!collections.length) continue;

      const dueTomorrow = collections.filter(c => c.date === tomorrowText);
      if (!dueTomorrow.length) continue;

      const upcoming = collections.filter(c => c.date !== tomorrowText);
      const message = this.replyBuilder.reminderMessage(this.env.APP_NAME, user.label || user.addressQuery, dueTomorrow, upcoming);

      await this.messageService.sendWhatsApp(phone, message);
      store.sent[sentKey] = { at: new Date().toISOString(), phone, date: markerDay };
      this.userStore.save(store);
    }
  }
}

module.exports = ReminderService;
