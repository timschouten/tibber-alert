import fetch from 'node-fetch';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const TIBBER_API_TOKEN = process.env.TIBBER_API_TOKEN;
const TIBBER_API_ENDPOINT = process.env.TIBBER_API_ENDPOINT;

if (!TIBBER_API_TOKEN || !TIBBER_API_ENDPOINT) {
  console.error("Error: TIBBER_API_TOKEN and TIBBER_API_ENDPOINT must be set in the .env file.");
  process.exit(1);
}

// --- GraphQL Queries ---

const GET_TODAY_PRICES_QUERY = `
{
  viewer {
    homes {
      currentSubscription {
        priceInfo {
          today {
            total
            energy
            tax
            startsAt
          }
        }
      }
    }
  }
}`;

const SEND_NOTIFICATION_MUTATION = `
mutation SendPushNotification($title: String!, $message: String!) {
  sendPushNotification(input: {
    title: $title,
    message: $message,
    screenToOpen: CONSUMPTION
  }){
    successful
    pushedToNumberOfDevices
  }
}`;

// --- Helper Functions ---

/**
 * Makes a GraphQL request to the Tibber API.
 * @param {string} query The GraphQL query or mutation.
 * @param {object} [variables] Optional variables for the query/mutation.
 * @returns {Promise<object>} The JSON response from the API.
 */
async function tibberRequest(query, variables = {}) {
  try {
    const response = await fetch(TIBBER_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TIBBER_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      console.error(`HTTP error! status: ${response.status}, message: ${await response.text()}`);
      return null;
    }

    const data = await response.json();
    if (data.errors) {
      console.error("GraphQL Errors:", JSON.stringify(data.errors, null, 2));
      return null;
    }
    return data.data;
  } catch (error) {
    console.error("Error making Tibber API request:", error);
    return null;
  }
}

/**
 * Sends a push notification via the Tibber API.
 * @param {object} cheapestHourToday The cheapest hour object { total, startsAt } for today.
 */
async function sendLowPriceNotification(cheapestHourToday) {
  if (!cheapestHourToday) {
    console.warn("Cannot send notification: Cheapest hour data missing.");
    return;
  }
  console.log(`Sending notification for cheapest hour today: ${cheapestHourToday.startsAt}`);
  const title = "Lage Prijs Alert!";
  const message = `De stroomprijs is nu het laagst vandaag: ${cheapestHourToday.total} EUR/kWh.`;

  try {
    const variables = { title, message };
    const result = await tibberRequest(SEND_NOTIFICATION_MUTATION, variables);
    if (result?.sendPushNotification?.successful) {
      console.log(`Notification sent successfully to ${result.sendPushNotification.pushedToNumberOfDevices} devices.`);
    } else {
      console.warn("Failed to send notification or no devices received it.", result);
    }
  } catch (error) {
    console.error("Error during push notification sending process.");
  }
}

/**
 * Fetches today's prices, finds the cheapest hour, and sends a notification if the current hour is the cheapest.
 */
async function checkPricesAndNotify() {
    console.log("Hourly check: Fetching today's prices...");
    const data = await tibberRequest(GET_TODAY_PRICES_QUERY);

    if (!data?.viewer?.homes?.[0]?.currentSubscription?.priceInfo?.today) {
        console.warn("Hourly check: Could not fetch or parse today's price data from Tibber API.");
        return;
    }

    const todayPrices = data.viewer.homes[0].currentSubscription.priceInfo.today;

    if (!Array.isArray(todayPrices) || todayPrices.length === 0) {
        console.warn("Hourly check: No price data available for today.");
        return;
    }

    let cheapestHourToday = null;
    try {
        cheapestHourToday = todayPrices.reduce((min, current) => {
            if (typeof current.total !== 'number' || current.total === null) {
                 console.warn(`Invalid price data encountered: ${JSON.stringify(current)}. Skipping.`);
                 return min;
            }
            return (min === null || current.total < min.total) ? current : min;
        }, null);
    } catch (error) {
        console.error("Error finding the cheapest hour:", error);
        return;
    }


    if (!cheapestHourToday) {
        console.warn("Hourly check: Could not determine the cheapest hour for today.");
        return;
    }

    console.log(`Hourly check: Cheapest hour today starts at ${cheapestHourToday.startsAt} with price ${cheapestHourToday.total}`);

    // Check if the *current* hour is the cheapest hour of the day
    const now = new Date();
    const cheapestHourDate = new Date(cheapestHourToday.startsAt);

    // Compare only year, month, day, and hour
    const isCheapestHourNow =
        now.getFullYear() === cheapestHourDate.getFullYear() &&
        now.getMonth() === cheapestHourDate.getMonth() &&
        now.getDate() === cheapestHourDate.getDate() &&
        now.getHours() === cheapestHourDate.getHours();

    if (isCheapestHourNow) {
        console.log(`Current hour (${now.getHours()}:00) IS the cheapest hour today. Sending notification.`);
        await sendLowPriceNotification(cheapestHourToday);
    } else {
        console.log(`Current hour (${now.getHours()}:00) is not the cheapest hour today. No notification sent.`);
    }
}


// --- Job Scheduling ---

cron.schedule('0 * * * *', checkPricesAndNotify, {
  scheduled: true,
  timezone: "Europe/Amsterdam"
});

// --- Initial Run ---
console.log("Tibber Price Alert Bot started.");
console.log("Checking prices for the first time...");

checkPricesAndNotify().catch(error => {
    console.error("Initial price check failed:", error);
});

console.log("Waiting for scheduled hourly checks...");