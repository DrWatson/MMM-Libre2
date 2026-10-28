/* global Module */
Module.register("MMM-Libre2", {
  defaults: {
    units: "mmol/L", staleAfterMinutes: 10, showGraph: true, showGraphLabel: true,
    graphHours: 6, width: 320, height: 360, animationSpeed: 300,
    minMmol: 3.9, maxMmol: 10, showSecondaryDisplayText: true,
    timeFormat: 24,
    "overColor": "orange", "underColor": "red", "withinRangeColor": "springgreen"
  },
  getStyles() { return ["MMM-Libre2.css"]; },
  start() {
    this.reading = null; this.error = null;
    this.clock = setInterval(() => this.updateDom(0), 30000);
  },
  notificationReceived(notification) {
    if (notification === "DOM_OBJECTS_CREATED") this.sendSocketNotification("LIBRE_START", {});
  },
  socketNotificationReceived(notification, payload) {
    if (notification === "LIBRE_DATA") { this.reading = payload; this.error = null; }
    else if (notification === "LIBRE_ERROR") this.error = payload.message;
    else return;
    this.updateDom(this.config.animationSpeed);
  },
  suspend() { clearInterval(this.clock); },
  resume() {
    clearInterval(this.clock);
    this.clock = setInterval(() => this.updateDom(0), 30000);
    this.sendSocketNotification("LIBRE_START", {});
    this.updateDom(0);
  },
  getDom() {
    const root = document.createElement("div"); root.className = "libre-panel";
    const pixels = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : fallback;
    root.style.width = `${Math.max(1, pixels(this.config.width, 320))}px`;
    root.style.height = `${Math.max(1, pixels(this.config.height, 360))}px`;
    const add = (text, className) => { const el = document.createElement("div"); el.className = className; el.textContent = text; root.appendChild(el); return el; };
    if (!this.reading) { add(this.error || "Connecting to LibreLinkUp…", "libre-status"); return root; }
    const r = this.reading.current;
    const age = Date.now() - r.timestamp;
    const stale = age > Math.max(1, Number(this.config.staleAfterMinutes) || 10) * 60000;
    const mmol = this.config.units !== "mg/dL";
    const value = mmol ? (r.mgdl / 18).toFixed(1) : Math.round(r.mgdl).toString();
    const arrows = ["", "↓", "↘", "→", "↗", "↑"];
    if (stale || this.error) root.classList.add("libre-unavailable");
    add(`${value} ${arrows[r.trend] || "—"}`, "libre-value bright");
    add(mmol ? "mmol/L" : "mg/dL", "libre-units");
    const minutesAgo = Math.floor(Math.max(0, age) / 60000);
    const readingAge = age < 60000 ? "less than 1 minute ago"
      : `${minutesAgo} ${minutesAgo === 1 ? "minute" : "minutes"} ago`;
    add(`Measured at ${new Date(r.timestamp).toLocaleTimeString([], {
      hour: Number(this.config.timeFormat) === 12 ? "numeric" : "2-digit", minute: "2-digit",
      hourCycle: Number(this.config.timeFormat) === 12 ? "h12" : "h23"
    })} (${readingAge})`, "libre-time");
    if (stale) add("STALE DATA — check your Libre app", "libre-warning");
    if (this.error) add(`Update failed. Last reading shown. ${this.error}`, "libre-status");
    if (!this.getThresholds().valid) add("Invalid glucose thresholds; using 3.9–10 mmol/L.", "libre-status");
    if (this.config.showGraph) this.drawGraph(root, this.reading.history || [], mmol);
    if (this.reading.historyUnavailable) add("History unavailable", "libre-status");
    if (this.config.showSecondaryDisplayText) add("Secondary display · keep Libre alarms active", "libre-note");
    return root;
  },
  getThresholds() {
    const min = Number(this.config.minMmol), max = Number(this.config.maxMmol);
    const valid = Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > min;
    return valid ? { min, max, valid } : { min: 3.9, max: 10, valid };
  },
  drawGraph(root, history, mmol) {
    const hours = Math.max(1, Math.min(12, Number(this.config.graphHours) || 6));
    const end = Date.now(); const begin = end - hours * 3600000;
    const points = history.filter(p => p.timestamp >= begin && p.timestamp <= end);
    if (this.config.showGraphLabel) {
      const label = document.createElement("div"); label.className = "libre-graph-label";
      label.textContent = `Last ${hours} hours`; root.appendChild(label);
    }
    if (!points.length) return;
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 220; canvas.className = "libre-graph";
    canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", `Glucose history over ${hours} hours`); root.appendChild(canvas);
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const values = points.map(p => mmol ? p.mgdl / 18 : p.mgdl);
    const thresholds = this.getThresholds();
    const low = mmol ? thresholds.min : thresholds.min * 18;
    const high = mmol ? thresholds.max : thresholds.max * 18;
    const min = Math.max(0, Math.min(low, ...values) - (mmol ? 1 : 18));
    const max = Math.max(high, ...values) + (mmol ? 1 : 18);
    const x = time => 55 + (time - begin) / (end - begin) * 575;
    const y = value => 180 - (value - min) / (max - min) * 155;
    const renderedWidth = root.clientWidth || parseFloat(root.style.width) || 320;
    // Keep axis text at 10 screen pixels as the canvas scales with module width.
    ctx.font = `${10 * canvas.width / renderedWidth}px sans-serif`; ctx.fillStyle = "#aaa"; ctx.strokeStyle = "#333";
    [min, (min + max) / 2, max].forEach(value => {
      ctx.fillText(mmol ? value.toFixed(1) : Math.round(value), 0, y(value) + 7);
      ctx.beginPath(); ctx.moveTo(55, y(value)); ctx.lineTo(630, y(value)); ctx.stroke();
    });
    // Keep hourly gridlines, but thin labels until their measured bounds fit.
    const labelGap = 8 * canvas.width / renderedWidth;
    const ticks = [];
    const lastHour = new Date(end); lastHour.setMinutes(0, 0, 0);
    const tickCount = Math.floor((lastHour.getTime() - begin) / 3600000);
    for (let hour = tickCount; hour >= 0; hour--) {
      const tickTime = new Date(lastHour.getTime() - hour * 3600000);
      const tickX = x(tickTime.getTime());
      ctx.beginPath(); ctx.moveTo(tickX, 25); ctx.lineTo(tickX, 180); ctx.stroke();
      const clockHour = tickTime.getHours();
      const text = Number(this.config.timeFormat) === 12
        ? `${clockHour % 12 || 12}${clockHour < 12 ? "AM" : "PM"}`
        : String(clockHour).padStart(2, "0");
      const align = hour === 0 ? "right" : hour === tickCount ? "left" : "center";
      const width = ctx.measureText(text).width;
      const left = align === "right" ? tickX - width : align === "left" ? tickX : tickX - width / 2;
      ticks.push({ hour, text, x: tickX, align, left, right: left + width });
    }
    let labelStep = 1, visibleTicks;
    while (true) {
      visibleTicks = ticks.filter(tick => tick.hour % labelStep === 0);
      const overlaps = visibleTicks.some((tick, index) => index && tick.left < visibleTicks[index - 1].right + labelGap);
      if (!overlaps) break;
      labelStep *= 2;
    }
    for (const tick of visibleTicks) {
      ctx.textAlign = tick.align;
      ctx.fillText(tick.text, tick.x, 215);
    }
    ctx.textAlign = "left";
    ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.setLineDash([1, 7]);
    [[low, this.config.underColor], [high, this.config.overColor]].forEach(([value, color]) => {
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(55, y(value)); ctx.lineTo(630, y(value)); ctx.stroke();
    });
    // History lines remain solid, independent of the dotted reference lines.
    ctx.setLineDash([]); ctx.lineCap = "butt";
    const color = value => value < low ? this.config["underColor"]
      : value > high ? this.config["overColor"] : this.config["withinRangeColor"];
    ctx.lineWidth = 3;
    points.forEach((p, index) => {
      const px = x(p.timestamp), py = y(values[index]);
      // Do not draw a continuous line across gaps over 20 minutes.
      if (index && p.timestamp - points[index - 1].timestamp <= 1200000) {
        const previousValue = values[index - 1], value = values[index];
        const previousX = x(points[index - 1].timestamp);
        // Split at each threshold so only the out-of-range portion changes color.
        const cuts = [0, 1];
        if (value !== previousValue) {
          [low, high].forEach(threshold => {
            const fraction = (threshold - previousValue) / (value - previousValue);
            if (fraction > 0 && fraction < 1) cuts.push(fraction);
          });
        }
        cuts.sort((a, b) => a - b);
        for (let part = 1; part < cuts.length; part++) {
          const start = cuts[part - 1], finish = cuts[part];
          const interpolate = fraction => previousValue + (value - previousValue) * fraction;
          ctx.strokeStyle = color(interpolate((start + finish) / 2));
          ctx.beginPath();
          ctx.moveTo(previousX + (px - previousX) * start, y(interpolate(start)));
          ctx.lineTo(previousX + (px - previousX) * finish, y(interpolate(finish)));
          ctx.stroke();
        }
      }
      ctx.fillStyle = color(values[index]);
      ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill();
    });
  }
});
