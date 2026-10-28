"use strict";

const { createHash } = require("node:crypto");

class LibreError extends Error {
  constructor(message, status = 0, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// FactoryTimestamp is the sensor's UTC timestamp; Timestamp is local wall time.
// Do not parse a zone-less Timestamp using the mirror's local timezone.
function parseTimestamp(value) {
  if (typeof value !== "string") return NaN;
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return Date.parse(value);
  }
  const m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/i);
  if (!m) return NaN;
  const [, month, day, year, hour, minute, second, period] = m;
  if (+hour < 1 || +hour > 12 || +month < 1 || +month > 12 || +day < 1 || +day > 31 || +minute > 59 || +second > 59) return NaN;
  const h = +hour % 12 + (period.toUpperCase() === "PM" ? 12 : 0);
  const time = Date.UTC(+year, +month - 1, +day, h, +minute, +second);
  const date = new Date(time);
  return date.getUTCMonth() === +month - 1 && date.getUTCDate() === +day ? time : NaN;
}

function normalize(measurement, now = Date.now()) {
  if (!measurement || measurement.ValueInMgPerDl == null || measurement.ValueInMgPerDl === "") return null;
  const mgdl = Number(measurement.ValueInMgPerDl);
  const timestamp = parseTimestamp(measurement.FactoryTimestamp);
  if (!Number.isFinite(mgdl) || mgdl <= 0 || !Number.isFinite(timestamp) || timestamp > now + 300000) return null;
  return { mgdl, timestamp, trend: Number(measurement.TrendArrow) || 0 };
}

class LibreClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    if (!config.email || !config.password) throw new LibreError("Set email and password in the server-side configuration.");
    this.config = config;
    this.fetch = fetchImpl;
    this.region = config.region || "";
    this.token = null;
    this.expires = 0;
    this.accountId = null;
  }

  baseUrl() {
    // Only Abbott-owned endpoints; never forward credentials to a supplied URL.
    if (!/^[a-z0-9-]{0,12}$/.test(this.region)) throw new LibreError("Invalid LibreLinkUp region code.");
    return this.region ? `https://api-${this.region}.libreview.io` : "https://api.libreview.io";
  }

  async request(path, body, authenticated = false) {
    const headers = {
      "content-type": "application/json", accept: "application/json",
      product: "llu.android", version: this.config.apiVersion || "4.17.0"
    };
    if (authenticated) {
      headers.authorization = `Bearer ${this.token}`;
      headers["account-id"] = this.accountId;
    }
    const url = this.baseUrl() + path;
    let response;
    try {
      response = await this.fetch(url, {
        method: body ? "POST" : "GET", headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000), redirect: "error"
      });
    } catch {
      throw new LibreError("Cannot reach LibreLinkUp. Check internet access and the regional service.");
    }
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const delay = /^\d+$/.test(retry || "") ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      throw new LibreError("LibreLinkUp rate limit reached; waiting before retrying.", 429, Math.max(900000, delay || 0));
    }
    let json;
    try { json = await response.json(); } catch { throw new LibreError("LibreLinkUp returned an unreadable response."); }
    if (!response.ok || (json.status !== undefined && json.status !== 0)) {
      // Never display raw response bodies: they can contain credentials or personal data.
      const minimum = json.data?.minimumVersion;
      const hint = minimum ? " The service requires a different client version; check the API compatibility notes." : "";
      throw new LibreError(`LibreLinkUp rejected the request (HTTP ${response.status}). Check login, account consent, or API compatibility.${hint}`, response.status);
    }
    return json.data;
  }

  async login() {
    this.token = null;
    for (let redirects = 0; redirects < 3; redirects++) {
      const data = await this.request("/llu/auth/login", { email: this.config.email, password: this.config.password });
      if (data?.redirect && data.region) { this.region = data.region; continue; }
      if (data?.step || !data?.authTicket?.token || !data?.user?.id) {
        throw new LibreError("Finish sign-in and accept any required terms in the official LibreLinkUp app, then stop that app and retry.", 403);
      }
      this.token = data.authTicket.token;
      this.accountId = createHash("sha256").update(String(data.user.id)).digest("hex");
      this.expires = Number(data.authTicket.expires) * 1000 || Date.now() + 300000;
      return;
    }
    throw new LibreError("Too many LibreLinkUp regional redirects.");
  }

  async get(path, retry = true) {
    if (!this.token || Date.now() >= this.expires - 60000) await this.login();
    try { return await this.request(path, undefined, true); }
    catch (error) {
      if (error.status === 401 && retry) { this.token = null; return this.get(path, false); }
      throw error;
    }
  }

  async read() {
    const connections = await this.get("/llu/connections");
    if (!Array.isArray(connections) || !connections.length) throw new LibreError("No shared connection. Accept the follower invitation in LibreLinkUp first.");
    const connection = this.config.patientId
      ? connections.find(c => c.patientId === this.config.patientId)
      : connections.length === 1 ? connections[0] : null;
    if (!connection) throw new LibreError("Multiple connections or no matching patientId. Configure the intended patientId on the server.");
    let current = normalize(connection.glucoseMeasurement);
    let history = [];
    let historyUnavailable = false;
    try {
      const graph = await this.get(`/llu/connections/${encodeURIComponent(connection.patientId)}/graph`);
      history = (Array.isArray(graph?.graphData) ? graph.graphData : []).map(m => normalize(m)).filter(Boolean);
      const graphCurrent = normalize(graph?.connection?.glucoseMeasurement);
      if (graphCurrent && (!current || graphCurrent.timestamp > current.timestamp)) current = graphCurrent;
    } catch (error) {
      if (error.status === 429 || error.status === 401 || error.status === 403) throw error;
      historyUnavailable = true;
    }
    if (!current) throw new LibreError("No valid timestamped glucose reading available. Check the Libre app and sensor connection.");
    history.push(current);
    history = [...new Map(history.map(p => [p.timestamp, p])).values()].sort((a, b) => a.timestamp - b.timestamp);
    return { current, history, historyUnavailable, fetchedAt: Date.now() };
  }
}

module.exports = { LibreClient, LibreError, parseTimestamp, normalize };
