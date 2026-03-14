const twilio = require("twilio");

class MessageService {
  constructor(accountSid, authToken, from) {
    this.client = twilio(accountSid, authToken);
    this.from = from;
  }

  async sendWhatsApp(to, body) {
    return this.client.messages.create({
      from: this.from,
      to,
      body
    });
  }

  twimlMessage(text) {
    const MessagingResponse = twilio.twiml.MessagingResponse;
    const resp = new MessagingResponse();
    resp.message(text);
    return resp.toString();
  }
}

module.exports = MessageService;
