# Bin Reminder - WhatsApp Conversational Bot

A Derby bin reminder service that works through WhatsApp.

## What it does

- User sends `JOIN`
- Bot asks for postcode
- Bot asks for address
- Bot stores the user
- User receives a WhatsApp reminder at 18:00 the night before collection

## Commands

- `JOIN`
- `NEXT`
- `STOP`
- `START`
- `HELP`

## Deployment

Deploy to Railway using the Dockerfile.

## Required environment variables

- `APP_NAME`
- `PORT`
- `TIMEZONE`
- `DATA_DIR`
- `RUN_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM`

## Railway notes

- Expose the service publicly
- Mount a persistent volume to `/data`
- Twilio WhatsApp webhook should point to `/whatsapp`
- Use a scheduled trigger for `/run-reminders?key=YOUR_RUN_KEY`
- Reminder time should be 18:00 Europe/London
