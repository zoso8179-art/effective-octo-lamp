# Derby Neighborhood Bot

A more complete WhatsApp neighborhood bot for Derby bin reminders.

## Features

- Derby City Council lookup
- Night-before WhatsApp reminders
- Multiple users and addresses
- Commands: HELP, JOIN, ADD, LIST, NEXT, SCHEDULE, PAUSE, START, REMOVE, TESTSEND
- Duplicate-send protection
- JSON state store

## Railway

- Use this as an exposed web service
- Mount a persistent volume at /data
- Point Twilio sandbox webhook to /whatsapp
