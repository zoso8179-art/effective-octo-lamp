require("dotenv").config();

module.exports = {
  APP_NAME: process.env.APP_NAME || "Derby Bin Reminder",
  PORT: parseInt(process.env.PORT || "3000", 10),
  TIMEZONE: process.env.TIMEZONE || "Europe/London",
  DATA_DIR: process.env.DATA_DIR || "/data",
  RUN_KEY: process.env.RUN_KEY || "",
  REMINDER_TIME_TEXT: process.env.REMINDER_TIME_TEXT || "18:00",
  DEFAULT_COUNCIL: process.env.DEFAULT_COUNCIL || "derby",
  TWILIO_SANDBOX_JOIN_PHRASE: process.env.TWILIO_SANDBOX_JOIN_PHRASE || "join path-avoid",
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",
  TWILIO_FROM: process.env.TWILIO_FROM || ""
};
