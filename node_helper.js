"use strict";
const NodeHelper = require("node_helper");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LibreClient } = require("./lib/client");

module.exports = NodeHelper.create({
  start() { this.running = false; this.timer = null; this.last = null; this.failures = 0; this.stopped = false; },
  socketNotificationReceived(notification) {
    if (notification !== "LIBRE_START") return;
    if (this.last) this.sendSocketNotification("LIBRE_DATA", this.last);
    if (this.running) return;
    this.running = true;
    try {
      const configPath = process.env.MMM_LIBRE2_CONFIG || path.join(os.homedir(), ".config", "MMM-Libre2", "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      this.client = new LibreClient(config);
      this.interval = Math.max(60000, Number(config.updateInterval) || 60000);
      this.poll();
    } catch {
      this.sendSocketNotification("LIBRE_ERROR", { message: "Cannot load server settings. Check ~/.config/MMM-Libre2/config.json, credentials, and JSON syntax." });
      this.running = false;
    }
  },
  async poll() {
    let delay = this.interval;
    try {
      const result = await this.client.read();
      this.last = result;
      this.failures = 0;
      if (!this.stopped) this.sendSocketNotification("LIBRE_DATA", result);
    } catch (error) {
      this.failures++;
      delay = Math.max(Math.min(this.interval * 2 ** Math.min(this.failures, 6), 1800000), error.retryAfterMs || 0);
      if ([401, 403].includes(error.status)) delay = Math.max(delay, 900000);
      if (!this.stopped) this.sendSocketNotification("LIBRE_ERROR", { message: error.message || "Update failed.", retryAt: Date.now() + delay });
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => this.poll(), delay);
    }
  },
  stop() { this.stopped = true; clearTimeout(this.timer); }
});
