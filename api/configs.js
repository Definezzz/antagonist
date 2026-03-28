const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join("/tmp", "antagonist-cloud-configs.json");

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeStore(obj) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(obj));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const store = readStore();

  if (req.method === "GET") {
    const q = req.query || {};
    const name = Array.isArray(q.name) ? q.name[0] : q.name;
    if (name && typeof name === "string") {
      const payload = store[name];
      if (payload == null) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "not found" }));
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ payload: String(payload) }));
    }
    const items = Object.keys(store)
      .sort()
      .map((n) => ({ name: n }));
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ items }));
  }

  if (req.method === "POST") {
    let body = req.body;
    if (body == null || body === "") {
      try {
        const raw = await readRequestBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "invalid json" }));
      }
    } else if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "invalid json" }));
      }
    }
    if (!body || typeof body !== "object") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "expected json body" }));
    }
    const name = body.name;
    const payload = body.payload;
    // Match Gamesense script: alphanumeric only (\fLua %w), no spaces/symbols
    if (!name || typeof name !== "string" || !/^[a-zA-Z0-9]+$/.test(name)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "name must be letters/digits only" }));
    }
    if (typeof payload !== "string" || payload.length === 0) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "payload must be non-empty string" }));
    }
    store[name] = payload;
    writeStore(store);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: true, name }));
  }

  res.statusCode = 405;
  res.end(JSON.stringify({ error: "method not allowed" }));
};
