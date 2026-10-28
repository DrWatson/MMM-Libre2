"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { LibreClient, parseTimestamp, normalize } = require("../lib/client");

const measurement = (offset = 0, mgdl = 126) => ({
  FactoryTimestamp: new Date(Date.now() + offset).toISOString(),
  ValueInMgPerDl: mgdl, TrendArrow: 3
});
const response = (data, status = 200, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: key => headers[key] || null },
  json: async () => ({ status: 0, data })
});
const ticket = () => ({ user: { id: "test-user" }, authTicket: { token: "test-token", expires: Date.now() / 1000 + 3600 } });

test("sensor wall timestamps are parsed as UTC, including noon and midnight", () => {
  assert.equal(parseTimestamp("10/27/2026 12:05:00 AM"), Date.UTC(2026, 9, 27, 0, 5));
  assert.equal(parseTimestamp("10/27/2026 12:05:00 PM"), Date.UTC(2026, 9, 27, 12, 5));
  assert.ok(Number.isNaN(parseTimestamp("2/30/2026 1:00:00 PM")));
  assert.ok(Number.isNaN(parseTimestamp("garbage")));
});

test("rejects missing, zero, invalid and future readings rather than displaying false values", () => {
  assert.equal(normalize({ ValueInMgPerDl: 0 }), null);
  assert.equal(normalize({ ...measurement(), ValueInMgPerDl: null }), null);
  assert.equal(normalize({ ...measurement(), FactoryTimestamp: "bad" }), null);
  assert.equal(normalize(measurement(600000)), null);
  assert.equal(normalize(measurement()).mgdl / 18, 7);
});

test("follows regional login and uses account hash; selects newer graph reading", async () => {
  const calls = [];
  const mock = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://api.libreview.io/llu/auth/login") return response({ redirect: true, region: "ca" });
    if (url.endsWith("/auth/login")) return response(ticket());
    if (url.endsWith("/connections")) return response([{ patientId: "p1", glucoseMeasurement: measurement(-60000, 108) }]);
    return response({ connection: { glucoseMeasurement: measurement(0, 126) }, graphData: [measurement(-60000, 108)] });
  };
  const client = new LibreClient({ email: "test@example.invalid", password: "test" }, mock);
  const result = await client.read();
  assert.equal(result.current.mgdl, 126);
  assert.equal(result.history.length, 2);
  assert.equal(calls[2].options.headers["account-id"], createHash("sha256").update("test-user").digest("hex"));
  assert.equal(calls[2].options.headers.authorization, "Bearer test-token");
  assert.ok(!JSON.stringify(result).includes("test-token"));
  assert.ok(!JSON.stringify(result).includes("test@example.invalid"));
});

test("does not silently select the wrong person when several connections exist", async () => {
  const mock = async url => url.endsWith("login") ? response(ticket()) : response([{ patientId: "a" }, { patientId: "b" }]);
  await assert.rejects(new LibreClient({ email: "test", password: "test" }, mock).read(), /patientId/);
});

test("one reauthentication on 401; persistent rejection never loops", async () => {
  let loginCount = 0, readCount = 0;
  const mock = async url => {
    if (url.endsWith("login")) { loginCount++; return response(ticket()); }
    readCount++; return response({}, 401);
  };
  await assert.rejects(new LibreClient({ email: "test", password: "test" }, mock).read(), /401/);
  assert.equal(loginCount, 2); assert.equal(readCount, 2);
});

test("rate limit retains a minimum fifteen-minute cooldown", async () => {
  const mock = async url => url.endsWith("login") ? response(ticket()) : response({}, 429, { "retry-after": "1200" });
  await assert.rejects(new LibreClient({ email: "test", password: "test" }, mock).read(), error => error.status === 429 && error.retryAfterMs === 1200000);
});

test("history outage keeps timestamped current data with an explicit history warning", async () => {
  const mock = async url => {
    if (url.endsWith("login")) return response(ticket());
    if (url.endsWith("connections")) return response([{ patientId: "p", glucoseMeasurement: measurement() }]);
    return response({}, 500);
  };
  const result = await new LibreClient({ email: "test", password: "test" }, mock).read();
  assert.equal(result.historyUnavailable, true); assert.equal(result.current.mgdl, 126);
});

test("rejects credential redirects outside the region-code format", async () => {
  const mock = async () => response({ redirect: true, region: "evil.invalid/path" });
  await assert.rejects(new LibreClient({ email: "test", password: "test" }, mock).read(), /Invalid.*region/);
});
