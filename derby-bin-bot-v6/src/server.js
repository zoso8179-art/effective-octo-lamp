const express = require("express");
const bodyParser = require("body-parser");

const env = require("./config/env");
const UserStore = require("./stores/userStore");
const MessageService = require("./services/messageService");
const CouncilRouter = require("./services/councilRouter");
const replyBuilder = require("./services/replyBuilder");
const OnboardingService = require("./services/onboardingService");
const ReminderService = require("./services/reminderService");
const MessageHandler = require("./bot/messageHandler");
const { normalizeWhatsApp } = require("./utils/text");

if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
  console.error("Missing Twilio configuration.");
  process.exit(1);
}

const userStore = new UserStore(env.DATA_DIR);
const messageService = new MessageService(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM);
const councilRouter = new CouncilRouter();
const onboardingService = new OnboardingService(councilRouter, replyBuilder, env);
const reminderService = new ReminderService(userStore, councilRouter, messageService, replyBuilder, env);
const messageHandler = new MessageHandler(userStore, onboardingService, councilRouter, replyBuilder, env);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send(`${env.APP_NAME} is running`);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: env.APP_NAME,
    timezone: env.TIMEZONE,
    reminder_time: env.REMINDER_TIME_TEXT,
    onboarding_model: "postcode + house number",
    sandbox_join_phrase: env.TWILIO_SANDBOX_JOIN_PHRASE
  });
});

app.post("/whatsapp", async (req, res) => {
  const from = normalizeWhatsApp(req.body.From || "");
  const body = req.body.Body || "";
  try {
    const reply = await messageHandler.handle(from, body);
    res.type("text/xml").send(messageService.twimlMessage(reply));
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.type("text/xml").send(messageService.twimlMessage("Something went wrong. Please try again."));
  }
});

app.get("/run-reminders", async (req, res) => {
  const key = req.query.key || "";
  if (env.RUN_KEY && key !== env.RUN_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  try {
    await reminderService.run();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(env.PORT, () => {
  console.log(`${env.APP_NAME} listening on ${env.PORT}`);
});
