// Server configuration for tests. Real services stay off: no Turnstile secret, sandboxed email
// written nowhere (tests pass their own sender), in-memory rate limits set high.
process.env.RUN_TOKEN_SECRET ??= "test-secret-test-secret-test-secret-0123456789";
process.env.MONGODB_URI ??= "mongodb://unused@localhost:1/unused";
process.env.EMAIL_SANDBOX = "1";
process.env.TURNSTILE_SECRET = "";
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.APP_URL = "https://game.test";
process.env.RATE_LIMITS = "runStart=100000/3600,saveIp=100000/3600";
