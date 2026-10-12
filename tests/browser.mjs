import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { makePlan } from "../web/core.js";
const root = path.resolve("web"),
  dataset = process.env.DISH_DATASET_ROOT;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
});
const context = await browser.newContext({
    viewport: { width: 1440, height: 1150 },
  }),
  page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// Local QA uses byte-identical frozen WAVs; deployed network accessibility is checked separately.
if (dataset)
  await context.route("https://huggingface.co/datasets/**", async (route) => {
    const u = new URL(route.request().url()),
      relative = u.pathname.split("/resolve/")[1].split("/").slice(1).join("/");
    const file = path.join(dataset, relative);
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: fs.readFileSync(file),
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
const origin = process.env.DISH_REVIEW_URL || "http://127.0.0.1:8765";
try {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("#total-scenes").textContent === "2,400",
  );
  await page.locator("#reviewer").fill("browser-qa");
  await page.locator("#set-reviewer").click();
  await page.locator("#calibrate").click();
  await page
    .locator("#headphones")
    .fill("QA synthetic playback (not a human review)");
  await page.locator('[data-cal="left"]').click();
  await page.locator("#cal-check").check();
  await page.locator("#save-cal").click();
  await page.locator("#seed").fill("ui-qa-1");
  await page.locator("#count").fill("4");
  await page.locator("#phase").selectOption("formal");
  await page.locator("#task").selectOption("all");
  await page.locator("#sample").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#play") &&
      !document.querySelector("#play").disabled,
    { timeout: 60000 },
  );
  assert.equal(await page.locator(".reference-box").count(), 0);
  assert.equal(await page.locator(".source-card").count(), 0);
  await page.locator("input[name=audibility][value=partial]").check();
  await page.locator("input[name=quality][value=pass]").check();
  await page
    .locator("textarea[name=notes]")
    .fill("TEST ONLY: synthetic browser workflow; no human judgment.");
  await page.locator("#submit-stage").click();
  await page.waitForTimeout(150);
  assert.match(await page.locator("#toast").textContent(), /完整试听/);
  const receivers = await page.locator(".receiver").count();
  for (let i = 0; i < receivers; i++) {
    await page.locator(".receiver").nth(i).click();
    await page.locator("#restart").click();
    await page.locator("#play").click();
    await page.waitForTimeout(12500);
  }
  await page.locator("#mark-now").click();
  await page.locator("#mark-start").fill("2");
  await page.locator("#mark-end").fill("3");
  await page.locator("#mark-note").fill("TEST: interval note");
  await page.locator("#add-mark").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await page.screenshot({ path: "docs/workspace.png", fullPage: true });
  await page.locator("#submit-stage").click();
  await page.waitForSelector(".reference-box");
  await page.waitForSelector(".source-card audio");
  assert((await page.locator("input[name=audibility]").count()) === 0);
  const source = page.locator(".source-card audio").first();
  await source.evaluate(async (a) => {
    a.load();
    await a.play();
  });
  await page.waitForTimeout(400);
  assert(await source.evaluate((a) => a.currentTime > 0));
  await source.evaluate((a) => a.pause());
  for (const dim of ["quality", "text", "target", "spatial", "cross"])
    await page.locator(`input[name=${dim}][value=uncertain]`).check();
  await page
    .locator("textarea[name=notes]")
    .fill("TEST ONLY: automation cannot supply human quality judgments.");
  await page.locator("#submit-stage").click();
  await page.waitForFunction(
    () => document.querySelector("#completed-count").textContent === "01",
  );
  const r = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("dish-profile:browser-qa")),
  );
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].blind.audibility, "partial");
  assert.equal(r.records[0].marks.length, 1);
  assert(r.records[0].review);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("#completed-count").textContent === "01",
  );
  await page.waitForSelector(".reference-box");
  assert((await page.locator(".reference-box").count()) === 1);
  const downloaded = page.waitForEvent("download");
  await page.locator("#export-results").click();
  const dl = await downloaded;
  assert.match(dl.suggestedFilename(), /dish-reviews-browser-qa.json/);
  await page.locator("[data-view=summary]").click();
  await page.locator("#my-summary").click();
  assert.match(await page.locator("#summary-body").textContent(), /未定义/);
  // Other reviewer remains independent even on the same shared sample list.
  await page.locator("[data-view=workspace]").click();
  await page.locator("#reviewer").fill("browser-qa-other");
  await page.locator("#set-reviewer").click();
  await page
    .locator("#import-plan")
    .setInputFiles({
      name: "plan.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(r.plan)),
    });
  await page.waitForSelector("#ratings");
  assert.equal(await page.locator(".reference-box").count(), 0);
  // Negative path: network failure cannot become a pass.
  await page.locator("input[name=audibility][value=clear]").check();
  await page.locator("input[name=quality][value=pass]").check();
  await page.locator("#playback-failed").check();
  await page.locator("textarea[name=notes]").fill("TEST: playback unavailable");
  await page.locator("#submit-stage").click();
  await page.waitForTimeout(100);
  assert.match(await page.locator("#toast").textContent(), /无法判断/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "docs/mobile.png", fullPage: true });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    "mobile overflow",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser workflow passed: playback coverage, blind lock, source FLAC, marks, save/reload/export, independent profiles, failure gating, responsive layout. QA records stayed in disposable browser storage.",
  );
} finally {
  await browser.close();
}
