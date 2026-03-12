
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const twilio = require('twilio');

const ADDRESS_QUERY = (process.env.ADDRESS_QUERY || "").toLowerCase();
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 19 * * *";
const TIMEZONE = process.env.TIMEZONE || "Europe/London";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function lookupBinDay() {
    const url = "https://secure.derby.gov.uk/binday/";
    const res = await axios.get(url);
    const $ = cheerio.load(res.data);

    let nextDate = null;

    $("table tr").each((i, el) => {
        const row = $(el).text().toLowerCase();
        if (row.includes(ADDRESS_QUERY)) {
            const match = row.match(/\d{1,2}\s+[a-z]+\s+\d{4}/);
            if (match) nextDate = match[0];
        }
    });

    return nextDate;
}

async function sendReminder(msg){
    await client.messages.create({
        from: process.env.TWILIO_FROM,
        to: process.env.TWILIO_TO,
        body: msg
    });
}

async function run(){
    const nextDate = await lookupBinDay();
    if(!nextDate) return;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate()+1);

    const t = tomorrow.toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"});

    if(nextDate.toLowerCase().includes(t.toLowerCase())){
        await sendReminder("Reminder: your bin collection is tomorrow. Put the bins out tonight.");
    }
}

cron.schedule(CRON_SCHEDULE, run, { timezone: TIMEZONE });

console.log("Bin reminder service started");
