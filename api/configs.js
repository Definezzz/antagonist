const fs = require("fs");
const path = require("path");

/**
 * IMPORTANT (Vercel serverless):
 * `/tmp` is ephemeral — use a real Redis in production.
 *
 * Supported env (first match wins):
 * 1) `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or legacy `KV_REST_*`) — HTTP REST
 * 2) `REDIS_URL` — TCP `redis://…` / `rediss://…` (Redis Cloud, Vercel Redis quickstart, etc.)
 *
 * Put secrets in Vercel → Project → Settings → Environment Variables, or `.env.local` for `vercel dev`.
 */
const STORE_PATH = path.join("/tmp", "antagonist-cloud-configs.json");
const KV_NAMES_KEY = "antagonist:cloud:names";
const kvPayloadKey = (name) => `antagonist:cloud:payload:${name}`;

let ioredisSingleton = null;

function getRedis() {
  const restUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (restUrl && restToken) {
    try {
      const { Redis } = require("@upstash/redis");
      return new Redis({ url: restUrl, token: restToken });
    } catch (e) {
      console.error("antagonist-cloud: @upstash/redis init failed — run npm install", e.message);
    }
  }

  const tcpUrl = process.env.REDIS_URL;
  if (tcpUrl && typeof tcpUrl === "string") {
    try {
      const IoRedis = require("ioredis");
      if (!ioredisSingleton) {
        ioredisSingleton = new IoRedis(tcpUrl, {
          maxRetriesPerRequest: 3,
          connectTimeout: 15000,
          lazyConnect: false
        });
      }
      return ioredisSingleton;
    } catch (e) {
      console.error("antagonist-cloud: ioredis init failed — run npm install", e.message);
    }
  }

  return null;
}

function readStoreFile() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeStoreFile(obj) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(obj));
}

async function redisListNames(redis) {
  const raw = await redis.get(KV_NAMES_KEY);
  if (raw == null) return [];
  let names;
  try {
    names = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(names)) return [];
  return names.filter((n) => typeof n === "string").sort();
}

async function redisGetName(redis, name) {
  return redis.get(kvPayloadKey(name));
}

async function redisSetName(redis, name, payload) {
  await redis.set(kvPayloadKey(name), payload);
  const raw = await redis.get(KV_NAMES_KEY);
  let names = [];
  if (raw != null) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) names = parsed;
    } catch {
      names = [];
    }
  }
  if (!names.includes(name)) {
    names.push(name);
    await redis.set(KV_NAMES_KEY, JSON.stringify(names));
  }
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

  const redis = getRedis();

  if (req.method === "GET") {
    const q = req.query || {};
    const name = Array.isArray(q.name) ? q.name[0] : q.name;

    if (name && typeof name === "string") {
      let payload = null;
      if (redis) {
        payload = await redisGetName(redis, name);
      } else {
        const store = readStoreFile();
        payload = store[name];
      }
      if (payload == null) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "not found" }));
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ payload: String(payload) }));
    }

    let items;
    if (redis) {
      const names = await redisListNames(redis);
      items = names.map((n) => ({ name: n }));
    } else {
      const store = readStoreFile();
      items = Object.keys(store)
        .sort()
        .map((n) => ({ name: n }));
    }
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
    const { name, payload } = body;
    if (
      !name ||
      typeof name !== "string" ||
      name.length > 120 ||
      !/^[a-zA-Z0-9 _\-]+$/.test(name)
    ) {
      res.statusCode = 400;
      return res.end(
        JSON.stringify({
          error: "name must be 1–120 chars: letters, digits, spaces, hyphen only",
        })
      );
    }
    if (typeof payload !== "string" || payload.length === 0) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "payload must be non-empty string" }));
    }

    if (redis) {
      await redisSetName(redis, name, payload);
    } else {
      const store = readStoreFile();
      store[name] = payload;
      writeStoreFile(store);
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: true, name }));
  }

  res.statusCode = 405;
  res.end(JSON.stringify({ error: "method not allowed" }));
};
