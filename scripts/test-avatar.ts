/**
 * Automated avatar QA script.
 *
 * 1. Opens the local playground in a headed Chromium browser.
 * 2. Connects to the LiveKit room and waits for the agent video.
 * 3. Sends a test phrase via chat to trigger avatar speech.
 * 4. Records the page (video + audio) for the configured duration.
 * 5. Sends the recording to Gemini 2.5 Pro for lip-sync & freeze analysis.
 * 6. Prints the analysis report.
 *
 * Usage:
 *   npx tsx scripts/test-avatar.ts [options]
 *
 * Options (env vars):
 *   GEMINI_API_KEY        — required
 *   PLAYGROUND_URL        — default http://localhost:3001
 *   TEST_PHRASE           — text to send via chat (default: long sentence)
 *   RECORD_SECONDS        — how long to record after sending text (default: 15)
 *   HEADED                — set to "false" for headless mode (default: true)
 */

import * as dotenv from "dotenv";
import { chromium } from "playwright";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";

// Load .env.local
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY env var is required");
  process.exit(1);
}

const PLAYGROUND_URL = process.env.PLAYGROUND_URL ?? "http://localhost:3001";
const TEST_PHRASE =
  process.env.TEST_PHRASE ??
  "Hello! Can you tell me a short story about a robot learning to dance? Make it about three sentences long.";
const RECORD_SECONDS = parseInt(process.env.RECORD_SECONDS ?? "15", 10);
const HEADED = process.env.HEADED !== "false";

const OUTPUT_DIR = path.join(__dirname, "..", "test-results");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const videoPath = path.join(OUTPUT_DIR, `avatar-test-${timestamp}.webm`);

  console.log(`\n--- Avatar QA Test ---`);
  console.log(`Playground:     ${PLAYGROUND_URL}`);
  console.log(`Test phrase:    "${TEST_PHRASE}"`);
  console.log(`Record length:  ${RECORD_SECONDS}s`);
  console.log(`Output dir:     ${OUTPUT_DIR}\n`);

  // Launch browser with video recording
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: 1280, height: 720 },
    },
    // Grant microphone permission (needed for WebRTC)
    permissions: ["microphone"],
  });

  const page = await context.newPage();

  try {
    // -----------------------------------------------------------------------
    // Step 1: Open playground
    // -----------------------------------------------------------------------
    console.log("[1/6] Opening playground...");
    await page.goto(PLAYGROUND_URL, { waitUntil: "networkidle" });

    // -----------------------------------------------------------------------
    // Step 2: Connect
    // -----------------------------------------------------------------------
    console.log("[2/6] Connecting to room...");
    const connectBtn = page.locator('button:has-text("Connect")').first();
    await connectBtn.click();

    // Wait for Disconnect button to appear (means we're connected)
    await page
      .locator('button:has-text("Disconnect")')
      .waitFor({ state: "visible", timeout: 30_000 });
    console.log("       Connected to room.");

    // -----------------------------------------------------------------------
    // Step 3: Wait for agent video
    // -----------------------------------------------------------------------
    console.log("[3/6] Waiting for agent video track...");
    await page
      .locator("video")
      .first()
      .waitFor({ state: "attached", timeout: 60_000 });
    console.log("       Agent video track received.");

    // Give the video a moment to start rendering
    await page.waitForTimeout(2000);

    // -----------------------------------------------------------------------
    // Step 4: Send test phrase via chat
    // -----------------------------------------------------------------------
    console.log(`[4/6] Sending test phrase...`);
    const chatInput = page.locator('input[placeholder="Type a message"]');

    // On small viewports the chat may be in a tab
    if (!(await chatInput.isVisible())) {
      const chatTab = page.locator('button:has-text("Chat")');
      if (await chatTab.isVisible()) {
        await chatTab.click();
        await chatInput.waitFor({ state: "visible" });
      }
    }

    await chatInput.fill(TEST_PHRASE);
    await chatInput.press("Enter");
    console.log("       Message sent, avatar should start speaking.");

    // -----------------------------------------------------------------------
    // Step 5: Record for N seconds
    // -----------------------------------------------------------------------
    console.log(`[5/6] Recording for ${RECORD_SECONDS}s...`);

    // Show a countdown in the terminal
    for (let i = RECORD_SECONDS; i > 0; i--) {
      process.stdout.write(`\r       ${i}s remaining...  `);
      await page.waitForTimeout(1000);
    }
    process.stdout.write(`\r       Recording complete.     \n`);

    // -----------------------------------------------------------------------
    // Step 6: Stop & save
    // -----------------------------------------------------------------------
    console.log("[6/6] Saving recording...");

    // Disconnect first to cleanly end the session
    const disconnectBtn = page.locator('button:has-text("Disconnect")');
    if (await disconnectBtn.isVisible()) {
      await disconnectBtn.click();
    }
  } finally {
    // Close page to finalize video recording
    await page.close();
    await context.close();
    await browser.close();
  }

  // Playwright saves the video with an auto-generated name — find it
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => ({
      name: f,
      time: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);

  if (files.length === 0) {
    console.error("ERROR: No video file was saved.");
    process.exit(1);
  }

  const savedVideo = path.join(OUTPUT_DIR, files[0].name);

  // Rename to our preferred name
  fs.renameSync(savedVideo, videoPath);
  console.log(`       Video saved: ${videoPath}`);

  const fileSizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1);
  console.log(`       File size: ${fileSizeMB} MB\n`);

  // -----------------------------------------------------------------------
  // Gemini Analysis
  // -----------------------------------------------------------------------
  console.log("--- Gemini Analysis ---\n");
  console.log("Uploading video to Gemini 2.5 Pro...");

  const analysis = await analyzeWithGemini(videoPath);
  console.log("\n" + analysis + "\n");

  // Save analysis report
  const reportPath = videoPath.replace(".webm", "-report.txt");
  fs.writeFileSync(reportPath, analysis);
  console.log(`Report saved: ${reportPath}`);
}

// ---------------------------------------------------------------------------
// Gemini analysis
// ---------------------------------------------------------------------------

async function analyzeWithGemini(videoPath: string): Promise<string> {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY!);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

  const videoData = fs.readFileSync(videoPath);
  const base64Video = videoData.toString("base64");

  const prompt = `You are a senior QA engineer specializing in real-time avatar rendering quality. You are analyzing a video recording of a talking-head digital avatar. Your job is to produce a precise, quantitative bug report — not a summary.

IMPORTANT INSTRUCTIONS:
- Watch the ENTIRE video frame by frame.
- Log EVERY individual incident with exact timestamps [MM:SS].
- Count occurrences precisely. Do not say "a few" or "some" — give exact numbers.
- For lip sync, measure the offset in approximate milliseconds or fractions of a second.
- Track whether issues are constant, intermittent, or degrading over time.
- Distinguish between the avatar being idle (expected still mouth) vs frozen (unexpected).

Produce the following report:

## 1. Freeze / Stutter Log

For EACH freeze or stutter incident, log a row in this table:

| # | Timestamp | Duration (approx) | Type | Description |
|---|-----------|-------------------|------|-------------|

Types: FREEZE (avatar completely stops moving), STUTTER (brief frame skip/jank), LOOP (same frames repeating)

After the table:
- **Total freeze count:** (exact number)
- **Total freeze duration:** (sum of all freeze durations)
- **Freeze pattern:** Is it random, periodic, or does it get worse over time? Does it correlate with speech start/end?
- **Longest freeze:** timestamp and duration

## 2. Lip Sync Analysis

For EACH lip sync issue, log a row:

| # | Timestamp | Offset | Direction | Description |
|---|-----------|--------|-----------|-------------|

- Offset: approximate delay in ms (e.g., "~200ms", "~500ms", "~1s")
- Direction: LATE (mouth moves after audio), EARLY (mouth moves before audio), STUCK (mouth stuck open/closed during speech), DRIFT (sync gradually worsens)

After the table:
- **Total out-of-sync incidents:** (exact count)
- **Sync pattern:** Is the offset constant (e.g., always ~300ms late) or does it drift/deteriorate over time?
- **Worst offset observed:** timestamp and approximate delay
- **Does sync recover?** After going out of sync, does it snap back or stay misaligned?
- **Mouth movement during silence:** Does the mouth move when the avatar is NOT speaking? (false positive)
- **Mouth still during speech:** Does the mouth stay closed/still when the avatar IS speaking? (false negative)

## 3. Visual Artifacts

Log any visual glitches:

| # | Timestamp | Type | Description |
|---|-----------|------|-------------|

Types: TEAR (screen tearing), ARTIFACT (rendering glitch), FLICKER, JUMP (sudden position change), BLEND (blending/ghosting between frames)

## 4. Timeline Summary

Provide a second-by-second timeline of the video using this format:
\`\`\`
[00:00-00:03] Idle, mouth closed, no issues
[00:03-00:05] Speech starts, lip sync OK, ~50ms late
[00:05-00:07] Lip sync drifts to ~300ms late
[00:07-00:08] FREEZE - avatar stuck for ~1s
[00:08-00:12] Recovered, lip sync back to ~100ms late
...
\`\`\`

## 5. Summary Metrics

- **Total freezes:** (exact count, 0 if none)
- **Average freeze duration:** (seconds, N/A if none)
- **Longest freeze:** (timestamp + duration, N/A if none)
- **Total lip sync failures:** (exact count of distinct incidents)
- **Average sync offset:** (ms across all incidents, N/A if none)
- **Worst sync offset:** (timestamp + ms)
- **Drift trend:** STABLE (offset stays constant) / WORSENING (offset grows over time) / IMPROVING (offset shrinks) / N/A — cite timestamps as evidence
- **False positives:** (count — mouth moving when avatar is silent)
- **False negatives:** (count — mouth still when avatar should be speaking)
- **Top 3 issues to fix** (ordered by frequency, with occurrence count for each)`;

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: "video/webm",
        data: base64Video,
      },
    },
    { text: prompt },
  ]);

  return result.response.text();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
