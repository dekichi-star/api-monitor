const https = require('https');

const API_URL = process.env.API_URL;
const REQUEST_BODY = process.env.REQUEST_BODY;
const INVENTORY_PATH = process.env.INVENTORY_PATH;
const TARGET_URL = process.env.TARGET_URL || '';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SESSION_COOKIE = process.env.SESSION_COOKIE;

function getAt(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function httpsPost(url, body, cookie) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Cookie': cookie || '',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendSlack(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const url = new URL(SLACK_WEBHOOK_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const now = new Date().toISOString();
  console.log(`[${now}] Check started`);

  try {
    const result = await httpsPost(API_URL, REQUEST_BODY, SESSION_COOKIE);
    console.log(`Status: ${result.status}`);

    if (result.status === 401 || result.status === 403) {
      await sendSlack(
        `⚠️ Auth error (${result.status}). Please update session.\n⏰ ${now}`
      );
      process.exit(1);
    }

    if (result.status !== 200) {
      console.log(`Unexpected status: ${result.status}`);
      process.exit(1);
    }

    const remaining = getAt(result.body, INVENTORY_PATH) ?? -1;
    console.log(`Remaining: ${remaining}`);

    if (remaining > 0) {
      console.log('Available! Sending notification...');
      await sendSlack(
        `🎉 *Available!*\n` +
        `🔗 ${TARGET_URL}\n` +
        `⏰ ${now}`
      );
    } else {
      console.log('Not available');
    }

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
