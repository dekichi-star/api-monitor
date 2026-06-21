const https = require('https');

const API_URL = process.env.API_URL;
const REQUEST_BODY = process.env.REQUEST_BODY; // template: {{plan}} {{course}} {{date}} {{dateDash}}
const INVENTORY_PATH = process.env.INVENTORY_PATH;
const TARGETS = process.env.TARGETS; // JSON array of URL strings or { name, url } objects
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SESSION_COOKIE = process.env.SESSION_COOKIE;

// Politeness delay between targets (ms) so we don't hammer the API.
const DELAY_MS = Number(process.env.CHECK_DELAY_MS || 1500);

function getAt(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// Parse TARGETS into a normalized [{ name?, url?, plan?, course?, date? }] list.
function parseTargets() {
  if (!TARGETS) throw new Error('TARGETS is not set');
  let arr;
  try { arr = JSON.parse(TARGETS); }
  catch (e) { throw new Error(`TARGETS is not valid JSON: ${e.message}`); }
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('TARGETS must be a non-empty JSON array');
  }
  return arr.map((entry) => {
    if (typeof entry === 'string') return { url: entry };
    if (entry && typeof entry === 'object') return { ...entry };
    throw new Error(`Invalid target entry: ${JSON.stringify(entry)}`);
  });
}

// Derive plan / course / date — from explicit fields, else from the URL path
// (/plan/{plan}/{course}/{date}/).
function extractParams(target) {
  let { plan, course, date } = target;
  if ((!plan || !course || !date) && target.url) {
    const segs = new URL(target.url).pathname.split('/').filter(Boolean);
    const idx = segs.indexOf('plan');
    if (idx >= 0) {
      plan = plan || segs[idx + 1];
      course = course || segs[idx + 2];
      date = date || segs[idx + 3];
    }
  }
  if (!plan || !course || !date) {
    throw new Error(`Could not extract plan/course/date from ${JSON.stringify(target)}`);
  }
  if (!/^\d{8}$/.test(date)) {
    throw new Error(`Invalid date "${date}" (expected YYYYMMDD) in ${JSON.stringify(target)}`);
  }
  return { plan, course, date };
}

function toDash(date) {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

// Fill {{plan}} {{course}} {{date}} {{dateDash}} in the REQUEST_BODY template.
function buildBody(template, params) {
  return template
    .replace(/\{\{\s*plan\s*\}\}/g, params.plan)
    .replace(/\{\{\s*course\s*\}\}/g, params.course)
    .replace(/\{\{\s*dateDash\s*\}\}/g, toDash(params.date))
    .replace(/\{\{\s*date\s*\}\}/g, params.date);
}

function targetName(target, params) {
  return target.name || `${params.plan}/${params.course}/${params.date}`;
}

async function main() {
  const now = new Date().toISOString();
  console.log(`[${now}] Check started`);

  let targets;
  try {
    targets = parseTargets();
  } catch (e) {
    console.error('Config error:', e.message);
    process.exit(1);
  }
  console.log(`Targets: ${targets.length}`);

  let checkedCount = 0;
  let availableCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];

    let params;
    try {
      params = extractParams(target);
    } catch (e) {
      console.error(`[skip] ${e.message}`);
      continue;
    }

    const name = targetName(target, params);
    const url = target.url || '';
    const body = buildBody(REQUEST_BODY, params);

    try {
      const result = await httpsPost(API_URL, body, SESSION_COOKIE);
      checkedCount++;
      console.log(`- ${name}: status ${result.status}`);

      // Cookie is shared across all targets, so one auth failure means every
      // target would fail — alert once and stop.
      if (result.status === 401 || result.status === 403) {
        await sendSlack(
          `⚠️ 認証エラー (${result.status})。SESSION_COOKIE を更新してください。\n⏰ ${now}`
        );
        console.error('Auth error — aborting remaining checks.');
        process.exit(1);
      }

      if (result.status !== 200) {
        console.error(`  [skip] Unexpected status ${result.status}`);
      } else {
        const remaining = getAt(result.body, INVENTORY_PATH) ?? -1;
        console.log(`  remaining: ${remaining}`);
        if (remaining > 0) {
          availableCount++;
          console.log('  Available! Sending notification...');
          await sendSlack(
            `🎉 *空きあり！* ${name}\n` +
            `🔗 ${url}\n` +
            `⏰ ${now}`
          );
        }
      }
    } catch (err) {
      // A single target failing (network, bad params, etc.) shouldn't stop the rest.
      console.error(`  [skip] Error for ${name}: ${err.message}`);
    }

    if (i < targets.length - 1) await sleep(DELAY_MS);
  }

  console.log(`Done. Checked ${checkedCount}/${targets.length}, available ${availableCount}.`);
}

main();
