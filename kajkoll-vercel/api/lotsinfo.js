const https = require("https");

export default async function handler(req, res) {
  const date = req.query?.date || todayStr();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date format" });
  }

  const lotsUrl =
    `https://app.sjofartsverket.se/pilotinfo` +
    `?SearchFrom=${date}&__Invariant=SearchFrom` +
    `&SearchTo=${date}&__Invariant=SearchTo` +
    `&SelectedPilotageArea=348&SelectedPilotageStatus=` +
    `&ShipName=&Callsign=&TableSize=100&auto=false&userAction=search`;

  const smhiUrl     = "https://opendata-download-metobs.smhi.se/api/version/latest/parameter/1/station/71420/period/latest-hour/data.json";
  const smhiWindUrl = "https://opendata-download-metobs.smhi.se/api/version/latest/parameter/4/station/71420/period/latest-hour/data.json";

  try {
    const [html, tempData, windData] = await Promise.all([
      fetchUrl(lotsUrl),
      fetchUrl(smhiUrl).catch(() => ""),
      fetchUrl(smhiWindUrl).catch(() => ""),
    ]);

    const vessels = parseLotsinfo(html);
    const weather = parseSmhi(tempData, windData);

    res.setHeader("Cache-Control", "public, max-age=120");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({ date, vessels, count: vessels.length, weather });
  } catch (err) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: err.message });
  }
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.5",
        "Accept-Encoding": "identity",
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchUrl(res.headers.location));
        return;
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function stripHtml(str) {
  return str
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&aring;/g, "å").replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö")
    .replace(/&Aring;/g, "Å").replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCharCode(parseInt(c, 16)))
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/\s+/g, " ").trim();
}

function getCells(row, tag) {
  const cells = [];
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "gi");
  let m;
  while ((m = re.exec(row)) !== null) cells.push(stripHtml(m[1]));
  return cells;
}

function getHeaders(html) {
  const theadMatch = html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  if (!theadMatch) return [];
  return getCells(theadMatch[1], "th");
}

function parseLotsinfo(html) {
  const vessels = [];
  const headers = getHeaders(html);

  const FIELD_PATTERNS = [
    { pattern: /fartyg|ship/i,              field: "name" },
    { pattern: /anropssignal|callsign/i,    field: "callsign" },
    { pattern: /status/i,                   field: "status" },
    { pattern: /fr[åa]n|from/i,             field: "fran" },
    { pattern: /^till$|^to$/i,              field: "till" },
    { pattern: /best[äa]llning|order/i,     field: "bestallningStart" },
    { pattern: /planerad|planned/i,         field: "planadStart" },
    { pattern: /p[åa]b[öo]rjad|started/i,  field: "started" },
    { pattern: /avslutad|finished|end/i,    field: "finished" },
  ];

  const colIndex = {};
  const usedFields = new Set();
  headers.forEach((h, i) => {
    for (const { pattern, field } of FIELD_PATTERNS) {
      if (pattern.test(h) && !usedFields.has(field)) {
        colIndex[i] = field;
        usedFields.add(field);
        break;
      }
    }
  });

  const fallback = { 0:"name", 1:"callsign", 2:"status", 3:"fran", 4:"till", 5:"bestallningStart", 6:"planadStart", 7:"started", 8:"finished" };
  const colMap = Object.keys(colIndex).length >= 3 ? colIndex : fallback;

  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return vessels;

  const rows = tbodyMatch[1].split(/<tr[\s>]/i).slice(1);
  for (const row of rows) {
    const cells = getCells(row, "td");
    if (cells.length < 3) continue;

    const vessel = { name:"", callsign:"", status:"", fran:"", till:"", bestallningStart:"", planadStart:"", started:"", finished:"" };
    cells.forEach((val, i) => { if (colMap[i]) vessel[colMap[i]] = val; });

    if (vessel.name) {
      vessel.name = vessel.name
        .replace(/^fartygsnamn\s*:\s*/i, "")
        .replace(/^ship\s*name\s*:\s*/i, "")
        .replace(/^vessel\s*:\s*/i, "")
        .trim();
    }

    if (vessel.name && vessel.name.length > 2 && !/^\d{4}-\d{2}-\d{2}/.test(vessel.name) && !/^\d+$/.test(vessel.name)) {
      vessels.push(vessel);
    }
  }
  return vessels;
}

function parseSmhi(tempJson, windJson) {
  try {
    let temp = null, wind = null;
    if (tempJson) {
      const t = JSON.parse(tempJson);
      const val = t?.value?.[t.value.length - 1]?.value;
      if (val !== undefined) temp = parseFloat(val).toFixed(1) + "°C";
    }
    if (windJson) {
      const w = JSON.parse(windJson);
      const val = w?.value?.[w.value.length - 1]?.value;
      if (val !== undefined) wind = (parseFloat(val) * 1.94384).toFixed(1) + " kn";
    }
    if (!temp && !wind) return null;
    return { temp: temp || "–", wind: wind || "–", dir: "" };
  } catch(e) { return null; }
}
