# Derby Bin Reminder V6

Refactored V6 codebase with:
- adapter architecture
- postcode + house number onboarding
- address confirmation
- NEXT / TOMORROW / STOP / START / HELP
- 18:00 reminder messaging
- share-friendly onboarding copy
- reminder deduplication

## Current live details for your setup

- Twilio sandbox number: +1 415 523 8886
- Twilio sandbox join phrase for this account: join path-avoid
- Railway public domain: https://effective-octo-lamp-production.up.railway.app
- Twilio webhook: https://effective-octo-lamp-production.up.railway.app/whatsapp
- Health check: https://effective-octo-lamp-production.up.railway.app/health

## Onboarding flow

1. User joins sandbox with `join path-avoid`
2. User sends postcode + house number, e.g. `DE22 1HH 14`
3. Bot finds address
4. Bot asks for YES or numbered selection if needed
5. Bot subscribes user and confirms next collection

## Deploy

- Upload files to GitHub
- Deploy to Railway
- Mount a persistent volume to `/data`
- Set environment variables from `.env.example`
- Set Twilio webhook to `/whatsapp`
- Call `/run-reminders?key=YOUR_RUN_KEY` daily at 18:00 Europe/London
