# Derby Bin Bot v5

WhatsApp bin reminder bot for Derby with low-friction onboarding.

## Onboarding model

User sends:
JOIN

Bot asks for:
postcode + house number

Example:
DE22 1HH 14

If one address match is found, the bot confirms and subscribes the user.
If multiple matches are found, the bot returns a numbered list and asks the user to reply with the number.

## Current live setup

Twilio sandbox number:
+1 415 523 8886

Twilio sandbox join phrase for this account:
join path-avoid

Railway public domain:
https://effective-octo-lamp-production.up.railway.app

Twilio webhook:
https://effective-octo-lamp-production.up.railway.app/whatsapp

Health check:
https://effective-octo-lamp-production.up.railway.app/health

## Notes

- The sandbox join phrase is account-specific.
- Reminder time is 18:00.
- Use a persistent volume mounted at /data.
- Trigger reminders via /run-reminders?key=YOUR_RUN_KEY
