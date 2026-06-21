const https = require('https');

const TARGETS = process.env.TARGETS; // JSON array of URL strings or { name, url } objects
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Politeness delay between targets (ms) so we don't hammer the API.
const DELAY_MS = Number(process.env.CHECK_DELAY_MS || 1500);

const HOST = process.env.API_HOST; // reservation host, kept out of source via secret
const LANGUAGE_ID = 82; // Japanese
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// GET/POST JSON against the reservation host. Returns { status, body }.
function apiRequest(method, path, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const options = {
      hostname: HOST,
      path,
      method,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        ...(data ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Origin': `https://${HOST}`,
        } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
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
      },
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

function targetName(target, params) {
  return target.name || `${params.plan}/${params.course}/${params.date}`;
}

function uniqSorted(nums) {
  return [...new Set(nums)].sort((a, b) => a - b);
}

// Replicates the booking site's own availability check (checkValidBasicPlan):
// a plan is bookable only when EVERY basic-plan group required by the itinerary
// schedule (one per night for multi-night stays) is covered by a room/plan that
// is still reservable (reservationTypeCode !== 'NONE') and before its deadline.
// Capacity-incompatible rooms are dropped first, mirroring omitOverCapacityHotelClasses.
function isBookable(searchBody, party) {
  const ti = searchBody && searchBody.tourItinerary;
  if (!ti) return { bookable: false, reason: 'no tourItinerary in response' };

  const rooms = (searchBody.tourHotelRoomClasses || []).filter((c) => {
    const min = (c.hotelRoomClass && c.hotelRoomClass.minimumCapacity) || 0;
    const max = (c.hotelRoomClass && c.hotelRoomClass.maximumCapacity) || 0;
    if (!min || !max) return true;
    return party >= min && party <= max;
  });
  if (rooms.length === 0 && ti.numberNights > 0) {
    return { bookable: false, reason: 'no room fits the party' };
  }

  const required = uniqSorted(
    (ti.tourSchedules || []).flatMap(s => (s.tourBasicPlanGroups || []).map(g => g.id))
  );

  const now = new Date();
  const allPlans = [].concat(
    rooms,
    searchBody.tourBusSeatClasses || [],
    searchBody.tourBusServiceSeatClasses || [],
    searchBody.tourOptionClasses || [],
    searchBody.tourCarRentalClasses || [],
    searchBody.tourAirplaneSeatClasses || [],
    searchBody.tourRailroadSeatClasses || [],
    searchBody.tourRentalClasses || [],
    searchBody.tourShipSeatClasses || [],
    searchBody.tourETCs || []
  ).filter(Boolean);

  const available = uniqSorted(allPlans.filter((c) => {
    if (c.reservationTypeCode === 'NONE') return false;
    if (c.webApplicationDeadline) {
      const dl = new Date(String(c.webApplicationDeadline).replace(' ', 'T') + '+09:00');
      if (!isNaN(dl) && now >= dl) return false;
    }
    return true;
  }).map(c => c.tourBasicPlanGroupId));

  const bookable = required.length > 0 &&
    JSON.stringify(required) === JSON.stringify(available);
  return { bookable, required, available, reason: bookable ? 'OK' : 'required groups not all reservable' };
}

// Resolve a target to its current availability via the public reservation API:
//   1) planDetail (GET)  -> tourItineraryId + minimumReservation (party size)
//   2) tour-basic-plan/search (POST) -> room/plan reservability
async function checkTarget(target) {
  const params = extractParams(target);
  const { plan, course, date } = params;

  const pd = await apiRequest('GET',
    `/user-api/spice/tour/integrate/tours/planDetail` +
    `?code=${encodeURIComponent(plan)}&tourItineraryCode=${encodeURIComponent(course)}` +
    `&departureDate=${date}&operationDate=${date}`);
  if (pd.status !== 200 || !pd.body || !pd.body.id) {
    throw new Error(`planDetail failed (status ${pd.status})`);
  }
  const tourItineraryId = pd.body.id;
  const party = (pd.body.tourData && pd.body.tourData.minimumReservation) || 1;

  const sr = await apiRequest('POST',
    `/user-api/spice/resv/integrate/norm/tour-reservations/tour-basic-plan/search`, {
      tourItineraryId,
      departureDate: toDash(date),
      languageId: LANGUAGE_ID,
      tourReservationNumbers: [
        { userTypeId: 1, reservationRoomNumber: 1, numberReservation: party, useUsers: party },
      ],
    });
  if (sr.status !== 200 || !sr.body) {
    throw new Error(`search failed (status ${sr.status})`);
  }

  const verdict = isBookable(sr.body, party);
  return { params, tourItineraryId, party, ...verdict };
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

  let okCount = 0;
  let availableCount = 0;
  let errorCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    let name = target.name || target.url || JSON.stringify(target);

    try {
      const result = await checkTarget(target);
      name = targetName(target, result.params);
      okCount++;
      console.log(`- ${name}: ${result.bookable ? 'AVAILABLE' : 'sold out'}` +
        ` (req=${JSON.stringify(result.required)} avail=${JSON.stringify(result.available)})`);

      if (result.bookable) {
        availableCount++;
        await sendSlack(
          `🎉 *空きあり！* ${name}\n` +
          `🔗 ${target.url || ''}\n` +
          `⏰ ${now}`
        );
      }
    } catch (err) {
      // A single target failing shouldn't stop the rest.
      errorCount++;
      console.error(`  [skip] ${name}: ${err.message}`);
    }

    if (i < targets.length - 1) await sleep(DELAY_MS);
  }

  console.log(`Done. ok ${okCount}/${targets.length}, available ${availableCount}, errors ${errorCount}.`);

  // If every target errored, the API likely changed — alert once so it gets noticed.
  if (okCount === 0 && errorCount > 0) {
    await sendSlack(
      `⚠️ 在庫チェックが全${targets.length}件失敗しました。APIの仕様変更の可能性があります。\n⏰ ${now}`
    );
    process.exit(1);
  }
}

main();
