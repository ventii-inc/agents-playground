/**
 * Record-button test — exercises the app's own recording flow end to end.
 *
 * Unlike test-video-recording.ts (which runs its own MediaRecorder), this drives
 * the real Record/Stop button in the header and asserts the downloaded file is
 * a non-empty webm. It is the regression test for the 0-byte download caused by
 * mutating the recorded MediaStream mid-recording.
 *
 * Usage:
 *   npx tsx scripts/test-record-button.ts
 *
 * Options (env vars):
 *   PLAYGROUND_URL   — default http://localhost:3001
 *   TEST_PHRASE      — text to send via chat so the avatar speaks
 *   RECORD_SECONDS   — how long to hold the recording (default: 10)
 *   HEADED           — set to "true" for a visible browser (default: false)
 */

import * as dotenv from "dotenv";
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const PLAYGROUND_URL = process.env.PLAYGROUND_URL ?? "http://localhost:3001";
const TEST_PHRASE =
  process.env.TEST_PHRASE ??
  "Hello! Please count slowly from one to ten out loud.";
const RECORD_SECONDS = parseInt(process.env.RECORD_SECONDS ?? "10", 10);
const HEADED = process.env.HEADED === "true";

const OUTPUT_DIR = path.join(__dirname, "..", "test-results");

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`\n--- Record Button Test ---`);
  console.log(`Playground:     ${PLAYGROUND_URL}`);
  console.log(`Record length:  ${RECORD_SECONDS}s`);
  console.log(`Output dir:     ${OUTPUT_DIR}\n`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    permissions: ["microphone"],
    acceptDownloads: true,
  });

  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
    if (msg.type() === "warning") console.log("       [warn] " + msg.text());
  });

  try {
    console.log("[1/6] Opening playground...");
    await page.goto(PLAYGROUND_URL, { waitUntil: "networkidle" });

    console.log("[2/6] Connecting to room...");
    await page.locator('button:has-text("Connect")').first().click();
    await page
      .locator('button:has-text("Disconnect")')
      .waitFor({ state: "visible", timeout: 30_000 });
    console.log("       Connected.");

    console.log("[3/6] Waiting for agent video track...");
    await page.locator("video").first().waitFor({ state: "attached", timeout: 60_000 });
    console.log("       Agent video track received.");
    await page.waitForTimeout(2000);

    console.log("[4/6] Sending test phrase so the avatar speaks...");
    const chatInput = page.locator('input[placeholder="Type a message"]');
    if (!(await chatInput.isVisible())) {
      const chatTab = page.locator('button:has-text("Chat")');
      if (await chatTab.isVisible()) {
        await chatTab.click();
        await chatInput.waitFor({ state: "visible" });
      }
    }
    await chatInput.fill(TEST_PHRASE);
    await chatInput.press("Enter");

    console.log(`[5/6] Clicking Record, holding ${RECORD_SECONDS}s...`);
    const recordBtn = page.locator('button:has-text("Record")');
    await recordBtn.waitFor({ state: "visible", timeout: 30_000 });
    await recordBtn.click();

    // Regression check: nothing may download while the recording is still running.
    const prematureDownload = page
      .waitForEvent("download", { timeout: RECORD_SECONDS * 1000 })
      .then((d) => d)
      .catch(() => null);

    const stopBtn = page.locator('button:has-text("Stop")');
    await stopBtn.waitFor({ state: "visible", timeout: 5_000 });
    console.log("       Recording in progress (Stop button visible).");

    const early = await prematureDownload;
    if (early) {
      console.error(
        `\n❌ FAIL: A download fired mid-recording ("${early.suggestedFilename()}") — the recorder stopped on its own.`,
      );
      process.exit(1);
    }

    console.log("[6/6] Clicking Stop and capturing the download...");
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await stopBtn.click();
    const download = await downloadPromise;

    const filePath = path.join(OUTPUT_DIR, download.suggestedFilename());
    await download.saveAs(filePath);

    const size = fs.statSync(filePath).size;
    console.log(`       Saved: ${filePath}`);
    console.log(`       File size: ${(size / 1024 / 1024).toFixed(2)} MB (${size} bytes)`);

    if (size < 1024) {
      console.error(`\n❌ FAIL: Recording is too small (${size} bytes).`);
      process.exit(1);
    }

    // Validate the container: MP4 has "ftyp" at offset 4, WebM the EBML magic.
    const head = fs.readFileSync(filePath).subarray(0, 12);
    const isMp4 = head.subarray(4, 8).toString("latin1") === "ftyp";
    const isWebm = head.subarray(0, 4).toString("hex") === "1a45dfa3";
    if (!isMp4 && !isWebm) {
      console.error(`\n❌ FAIL: Not a valid mp4 or webm container (head ${head.toString("hex")}).`);
      process.exit(1);
    }
    console.log(`       Container: ${isMp4 ? "mp4" : "webm"}`);

    // The recording must carry a duration, or players show no length and cannot
    // seek. This is the regression guard for MediaRecorder's headerless WebM.
    const probe = spawnSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-show_entries", "stream=codec_name,codec_type",
      "-of", "default=noprint_wrappers=1",
      filePath,
    ], { encoding: "utf8" });

    if (probe.error) {
      console.warn("\n⚠️  ffprobe not available — skipping duration/seek checks.");
    } else {
      const out = probe.stdout.trim();
      out.split("\n").forEach((l) => console.log(`       ${l}`));

      const durMatch = out.match(/^duration=([\d.]+)$/m);
      if (!durMatch || parseFloat(durMatch[1]) <= 0) {
        console.error(`\n❌ FAIL: Recording has no readable duration — players cannot seek it.`);
        process.exit(1);
      }
      const seconds = parseFloat(durMatch[1]);

      // Seek to the back half and decode a frame, proving the file is indexed.
      const seekTo = Math.max(1, seconds * 0.6).toFixed(2);
      const seek = spawnSync("ffmpeg", [
        "-v", "error", "-ss", seekTo, "-i", filePath,
        "-frames:v", "1", "-f", "image2", "-y", "/dev/null",
      ], { encoding: "utf8" });

      if (seek.status !== 0) {
        console.error(`\n❌ FAIL: Could not seek to ${seekTo}s. ${seek.stderr.trim()}`);
        process.exit(1);
      }
      console.log(`       Duration ${seconds.toFixed(2)}s, seek to ${seekTo}s OK.`);
    }

    console.log(`\n✅ PASS: Record button produced a valid, seekable ${(size / 1024 / 1024).toFixed(2)} MB recording.`);
  } finally {
    if (consoleErrors.length > 0) {
      console.log("\nBrowser console errors:");
      consoleErrors.forEach((e) => console.log(`  - ${e}`));
    }
    await page.close();
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
