const crypto = require("crypto");
const { getRedis } = require("../lib/redis");

const KV_LICENSE_INDEX = "antagonist:license:index";
const kvLicenseKey = (token) => `antagonist:license:key:${token}`;
const KV_LOADER_SCRIPT = "antagonist:loader:script";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-license-admin-secret"
  );
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function redisGetJson(redis, key) {
  const raw = await redis.get(key);
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function redisSetJson(redis, key, obj) {
  await redis.set(key, JSON.stringify(obj));
}

async function redisAddToIndex(redis, token) {
  const raw = await redis.get(KV_LICENSE_INDEX);
  let list = [];
  if (raw != null) {
    try {
      list = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) list = [];
  if (!list.includes(token)) {
    list.push(token);
    await redis.set(KV_LICENSE_INDEX, JSON.stringify(list));
  }
}

function parseBearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function daysFromNowMs(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return null;
  return Date.now() + Math.floor(d * 86400000);
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const redis = getRedis();
  if (!redis) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: false, error: "redis_not_configured" }));
  }

  if (req.method === "GET") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        ok: true,
        message: "POST JSON { action, ... } or auth via POST body",
        actions: ["auth", "generate", "set_script", "revoke"],
      })
    );
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
  }

  let body = {};
  try {
    const raw = await readRequestBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: false, error: "invalid_json" }));
  }

  const adminSecret = process.env.LICENSE_ADMIN_SECRET || "";
  const action = typeof body.action === "string" ? body.action : "auth";

  const assertAdmin = () => {
    const secret =
      body.secret ||
      parseBearer(req) ||
      req.headers["x-license-admin-secret"];
    if (!adminSecret || secret !== adminSecret) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "forbidden" }));
      return false;
    }
    return true;
  };

  if (action === "generate") {
    if (!assertAdmin()) return;

    const token = crypto.randomBytes(16).toString("hex");
    const record = {
      createdAt: Date.now(),
      active: true,
      hwid: typeof body.hwid === "string" && body.hwid.length > 0 ? body.hwid : null,
      expiresAt:
        body.expiresAt != null && body.expiresAt !== ""
          ? Number(body.expiresAt)
          : body.days != null
            ? daysFromNowMs(body.days)
            : null,
      note: typeof body.note === "string" ? body.note.slice(0, 200) : "",
    };

    await redis.set(kvLicenseKey(token), JSON.stringify(record));
    await redisAddToIndex(redis, token);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: true, key: token, record }));
  }

  if (action === "set_script") {
    if (!assertAdmin()) return;
    const script = typeof body.script === "string" ? body.script : "";
    if (!script.length) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ ok: false, error: "script_required" }));
    }
    await redis.set(KV_LOADER_SCRIPT, script);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: true, bytes: script.length }));
  }

  if (action === "revoke") {
    if (!assertAdmin()) return;
    const key = typeof body.key === "string" ? body.key : "";
    if (!key) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ ok: false, error: "key_required" }));
    }
    const rec = await redisGetJson(redis, kvLicenseKey(key));
    if (rec) {
      rec.active = false;
      await redisSetJson(redis, kvLicenseKey(key), rec);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: true }));
  }

  if (action === "auth" || action === "") {
    const key =
      (typeof body.key === "string" && body.key) || parseBearer(req) || "";
    const hwid = typeof body.hwid === "string" ? body.hwid : "";

    if (!key) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ ok: false, error: "key_required" }));
    }

    const rec = await redisGetJson(redis, kvLicenseKey(key));
    if (!rec || rec.active === false) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ ok: false, error: "invalid_license" }));
    }

    if (rec.expiresAt != null && Number(rec.expiresAt) < Date.now()) {
      res.statusCode = 410;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ ok: false, error: "license_expired" }));
    }

    if (rec.hwid && rec.hwid.length > 0 && hwid && hwid !== rec.hwid) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ ok: false, error: "hwid_mismatch" }));
    }

    if ((!rec.hwid || rec.hwid.length === 0) && hwid.length > 0) {
      rec.hwid = hwid;
      await redisSetJson(redis, kvLicenseKey(key), rec);
    }

    const script = await redis.get(KV_LOADER_SCRIPT);
    if (script == null || String(script).length === 0) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ ok: false, error: "script_not_published" }));
    }

    const scriptB64 = Buffer.from(String(script), "utf8").toString("base64");

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify({
        ok: true,
        script_b64: scriptB64,
      })
    );
  }

  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.end(JSON.stringify({ ok: false, error: "unknown_action" }));
};
