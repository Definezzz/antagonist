let ioredisSingleton = null;

function getRedis() {
  const restUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (restUrl && restToken) {
    try {
      const { Redis } = require("@upstash/redis");
      return new Redis({ url: restUrl, token: restToken });
    } catch (e) {
      console.error("license: @upstash/redis init failed", e.message);
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
          lazyConnect: false,
        });
      }
      return ioredisSingleton;
    } catch (e) {
      console.error("license: ioredis init failed", e.message);
    }
  }

  return null;
}

module.exports = { getRedis };
