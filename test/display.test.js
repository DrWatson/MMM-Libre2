"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function makeModule(fixedNow) {
  let definition;
  const strokes = [], fills = [], labels = [];
  const context = {
    beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fillText(text, x, y) { labels.push({ text, x, y, align: this.textAlign }); },
    measureText(text) { return { width: text.length * parseFloat(this.font) * 0.6 }; },
    stroke() { strokes.push(this.strokeStyle); }, fill() { fills.push(this.fillStyle); }
  };
  const document = { createElement: () => ({
    className: "", textContent: "", style: {}, children: [],
    classList: { add() {} }, appendChild(child) { this.children.push(child); },
    setAttribute() {}, getContext: () => context
  }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../MMM-Libre2.js"), "utf8"), {
    Module: { register(name, module) { definition = module; } }, document, Date: fixedNow === undefined ? Date : class extends Date { static now() { return fixedNow; } }, Math, Number, setInterval, clearInterval
  });
  return { ...definition, strokes, fills, labels, config: { ...definition.defaults, showGraph: false } };
}
const text = root => [root.textContent, ...root.children.map(text)].join(" ");

test("measurement time supports both clock formats, including midnight", () => {
  const module = makeModule();
  for (const hour of [0, 13]) {
    const timestamp = new Date(2026, 9, 27, hour, 5).getTime();
    module.reading = { current: { mgdl: 126, timestamp, trend: 3 } };
    for (const format of [12, 24]) {
      module.config.timeFormat = format;
      const expected = new Date(timestamp).toLocaleTimeString([], {
        hour: format === 12 ? "numeric" : "2-digit", minute: "2-digit", hourCycle: format === 12 ? "h12" : "h23"
      });
      const measured = module.getDom().children.find(child => child.className === "libre-time");
      assert.ok(measured.textContent.startsWith(`Measured at ${expected} (`));
      if (format === 12) assert.doesNotMatch(measured.textContent, /Measured at 0\d:/);
    }
  }
});

test("combines measurement time and age in one status with singular and plural minutes", () => {
  const module = makeModule();
  for (const [age, expected] of [[30000, "less than 1 minute ago"], [90000, "1 minute ago"], [150000, "2 minutes ago"]]) {
    module.reading = { current: { mgdl: 126, timestamp: Date.now() - age, trend: 3 } };
    const root = module.getDom();
    const statuses = root.children.filter(child => child.className === "libre-time");
    assert.equal(statuses.length, 1);
    assert.ok(statuses[0].textContent.endsWith(`(${expected})`));
    assert.equal(root.children.some(child => child.className === "libre-age"), false);
  }
});

test("hour gridlines align with local clock hours and follow both clock formats", () => {
  const end = new Date(2026, 9, 27, 13, 30).getTime();
  for (const format of [12, 24]) {
    const module = makeModule(end);
    Object.assign(module.config, { showGraph: true, graphHours: 6, width: 1200, timeFormat: format });
    module.reading = { current: { mgdl: 126, timestamp: end, trend: 3 }, history: [{ mgdl: 126, timestamp: end }] };
    module.getDom();
    const ticks = module.labels.filter(label => label.y === 215);
    assert.deepEqual(ticks.map(label => label.text), format === 12
      ? ["8AM", "9AM", "10AM", "11AM", "12PM", "1PM"]
      : ["08", "09", "10", "11", "12", "13"]);
    assert.ok(Math.abs(ticks[0].x - (55 + 575 / 12)) < 0.001);
    for (let i = 1; i < ticks.length; i++) assert.ok(Math.abs(ticks[i].x - ticks[i - 1].x - 575 / 6) < 0.001);
  }
});

test("hour labels cross midnight without zero-padding twelve-hour labels", () => {
  const end = new Date(2026, 9, 28, 1, 30).getTime();
  for (const format of [12, 24]) {
    const module = makeModule(end);
    Object.assign(module.config, { showGraph: true, graphHours: 3, width: 1000, timeFormat: format });
    module.reading = { current: { mgdl: 126, timestamp: end }, history: [{ mgdl: 126, timestamp: end }] };
    module.getDom();
    assert.deepEqual(module.labels.filter(t => t.y === 215).map(t => t.text), format === 12
      ? ["11PM", "12AM", "1AM"] : ["23", "00", "01"]);
  }
});

test("crowded clock labels skip hours without removing hourly gridlines", () => {
  const end = new Date(2026, 9, 27, 13, 30).getTime();
  for (const width of [320, 80]) {
    const module = makeModule(end);
    Object.assign(module.config, { showGraph: true, graphHours: 12, width, timeFormat: 12 });
    module.reading = { current: { mgdl: 126, timestamp: end, trend: 3 }, history: [{ mgdl: 126, timestamp: end }] };
    module.getDom();
    const ticks = module.labels.filter(label => label.y === 215);
    assert.ok(ticks.length < 12);
    assert.equal(ticks.at(-1).text, "1PM");
    let previousRight = -Infinity;
    for (const tick of ticks) {
      const textWidth = tick.text.length * (10 * 640 / width) * 0.6;
      const left = tick.align === "left" ? tick.x : tick.align === "right" ? tick.x - textWidth : tick.x - textWidth / 2;
      assert.ok(left >= previousRight + 8 * 640 / width);
      previousRight = left + textWidth;
    }
    assert.equal(module.strokes.filter(color => color === "#333").length, 15);
  }
});

test("formats mmol and mgdl and keeps stale warning tied to sensor time", () => {
  const module = makeModule();
  module.reading = { current: { mgdl: 126, timestamp: Date.now() - 12 * 60000, trend: 3 } };
  assert.match(text(module.getDom()), /7\.0 →/);
  assert.match(text(module.getDom()), /STALE DATA/);
  module.config.units = "mg/dL";
  assert.match(text(module.getDom()), /126 →/);
});

test("honors pixel dimensions without the former width clamp; note visibility is configurable", () => {
  const module = makeModule();
  module.config.width = 900; module.config.height = 500;
  module.reading = { current: { mgdl: 126, timestamp: Date.now(), trend: 3 } };
  let root = module.getDom();
  assert.equal(root.style.width, "900px"); assert.equal(root.style.height, "500px");
  assert.match(text(root), /Secondary display/);
  module.config.showSecondaryDisplayText = false;
  root = module.getDom();
  assert.doesNotMatch(text(root), /Secondary display/);
});

test("splits rising and falling graph segments at both thresholds", () => {
  const module = makeModule(); module.config.showGraph = true;
  const now = Date.now() - 1000;
  module.reading = { current: { mgdl: 54, timestamp: now, trend: 3 }, history: [
    { mgdl: 54, timestamp: now - 1200000 },
    { mgdl: 198, timestamp: now - 600000 },
    { mgdl: 54, timestamp: now }
  ] };
  module.getDom();
  assert.deepEqual(module.strokes.filter(color => color !== "#333"), [
    "red", "springgreen", "orange", "orange", "springgreen", "red"
  ]);
});

test("configured named colors apply to each range", () => {
  const module = makeModule(); module.config.showGraph = true;
  module.config["underColor"] = "crimson";
  module.config["withinRangeColor"] = "limegreen";
  module.config["overColor"] = "gold";
  const now = Date.now() - 1000;
  module.reading = { current: { mgdl: 198, timestamp: now, trend: 3 }, history: [
    { mgdl: 54, timestamp: now - 1200000 },
    { mgdl: 126, timestamp: now - 600000 },
    { mgdl: 198, timestamp: now }
  ] };
  module.getDom();
  assert.deepEqual(module.fills, ["crimson", "limegreen", "gold"]);
  assert.deepEqual(module.strokes.filter(color => color !== "#333"), ["crimson", "limegreen", "limegreen", "gold"]);
});

test("custom mmol thresholds also apply when the display uses mg/dL, with inclusive boundaries", () => {
  const module = makeModule(); module.config.showGraph = true; module.config.units = "mg/dL";
  module.config.minMmol = 4; module.config.maxMmol = 9;
  const now = Date.now() - 1000;
  module.reading = { current: { mgdl: 162, timestamp: now, trend: 3 }, history: [
    { mgdl: 72, timestamp: now - 600000 }, { mgdl: 162, timestamp: now }
  ] };
  module.getDom();
  assert.deepEqual(module.fills, ["springgreen", "springgreen"]);
  assert.deepEqual(module.strokes.filter(color => color !== "#333"), ["springgreen"]);
});

test("invalid thresholds are reported and missing-data gaps remain disconnected", () => {
  const module = makeModule(); module.config.showGraph = true;
  module.config.minMmol = 11; module.config.maxMmol = 3;
  const now = Date.now() - 1000;
  module.reading = { current: { mgdl: 126, timestamp: now, trend: 3 }, history: [
    { mgdl: 54, timestamp: now - 3600000 }, { mgdl: 198, timestamp: now }
  ] };
  assert.match(text(module.getDom()), /Invalid glucose thresholds/);
  assert.equal(module.strokes.filter(color => color !== "#333").length, 0);
});

test("offline cached reading is clearly labeled and an empty display shows no fabricated value", () => {
  const module = makeModule(); module.error = "Connection failed";
  assert.doesNotMatch(text(module.getDom()), /mmol\/L/);
  module.reading = { current: { mgdl: 126, timestamp: Date.now(), trend: 3 } };
  assert.match(text(module.getDom()), /Update failed\. Last reading shown/);
});
