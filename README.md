# Derby Bin Reminder V8

WhatsApp bot that reminds Derby residents to put their bins out the night before collection day.

---

## What's new in V8

- Persistent user storage (users survive server restarts)
- Proper error handling on all scraper calls
- Timezone-safe date handling (BST/GMT via luxon)
- Postcode validation with clear error messages
- House number step removed (was collected but never used)
- Postcode correction flow during onboarding
- RESET command to change postcode or start over
- Commands (STOP/START/HELP/NEXT/TOMORROW) only active after setup
- Scrape results cached per postcode during reminder runs
- Logging throughout for Railway log viewer
- /run-reminders returns sent/error counts
- /health no longer exposes sandbox join phrase

---

## Setup

### 1. Environment variables

Copy `.env.example` and fill in your values in Railway (or `.env` for local):

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | From your Twilio Console |
| `TWILIO_AUTH_TOKEN` | From your Twilio Console |
| `TWILIO_FROM` | Your WhatsApp-enabled Twilio number, e.g. `whatsapp:+14155238886` |
| `RUN_KEY` | A secret string to protect `/run-reminders` |
| `PORT` | Set automatically by Railway; use 3000 locally |

### 2. Deploy to Railway

1. Push this repo to GitHub
2. Connect repo in Railway → New Project → Deploy from GitHub
3. Add the environment variables above in Railway → Variables
4. Railway will run `npm start` automatically

### 3. Set Twilio webhook

In your Twilio Console → Messaging → Sandbox (or your number):

- Webhook URL: `https://your-railway-url.up.railway.app/whatsapp`
- Method: `POST`

---

## Twilio sandbox onboarding

> **Important for sharing with others**
>
> Before anyone can use the bot they must join your Twilio sandbox first.
>
> Send them this link (replace the text after `?text=` with your join phrase):
>
> `https://wa.me/14155238886?text=join%20path-avoid`
>
> Once Twilio confirms they've joined, they can message the bot normally.

To find your current join phrase: Twilio Console → Messaging → Try it out → Send a WhatsApp message.

---

## User flow

```
User messages bot
→ Send postcode (e.g. DE1 1AA)
→ Confirm with YES (or correct postcode)
→ Active — reminders at 18:00 the night before collection
```

---

## Commands (once active)

| Command | Action |
|---|---|
| `NEXT` | Shows next scheduled collection |
| `TOMORROW` | Checks if there's a collection tomorrow |
| `STOP` | Pauses reminders |
| `START` | Resumes reminders |
| `RESET` | Clears registration, start over |
| `HELP` | Shows command list |

---

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Status check |
| `GET /health` | JSON health info + user counts |
| `POST /whatsapp` | Twilio webhook |
| `GET /run-reminders?key=YOUR_RUN_KEY` | Trigger reminder run |

---

## Scheduled reminders

The `/run-reminders` endpoint needs to be called at 18:00 UK time every day.

**Option A — Railway cron (recommended):**
Add a cron job in Railway that calls:
```
GET https://your-app.up.railway.app/run-reminders?key=YOUR_RUN_KEY
```
Schedule: `0 17 * * *` (17:00 UTC = 18:00 UK time in winter; adjust for BST or use a timezone-aware cron service)

**Option B — cron-job.org (free):**
Create a free account at cron-job.org and schedule an HTTP GET to the URL above.

---

## Data storage

Users are stored in `users.json` in the app directory. This file is created automatically on first run. It persists across restarts as long as the Railway volume or filesystem is intact.

> **Note:** Railway's ephemeral filesystem resets on redeploy. For a production setup with many users, replace the JSON file store with a Railway Redis add-on or a free database like PlanetScale/Supabase.

---

## Local development

```bash
npm install
cp .env.example .env
# fill in your .env values
node index.js
```

Use [ngrok](https://ngrok.com) to expose your local server to Twilio:
```bash
ngrok http 3000
```
Then set your Twilio webhook to the ngrok HTTPS URL + `/whatsapp`.
