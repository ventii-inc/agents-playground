/**
 * Video recording test — captures the avatar's actual WebRTC video + audio stream.
 *
 * 1. Opens the playground in a headed Chromium browser.
 * 2. Connects to the LiveKit room and waits for the agent video.
 * 3. Sends a test phrase via chat to trigger avatar speech.
 * 4. Grabs the avatar's video and audio MediaStreamTracks directly from the DOM.
 * 5. Records via MediaRecorder in the browser for the configured duration.
 * 6. Extracts the recorded blob and saves to disk.
 *
 * Usage:
 *   npx tsx scripts/test-video-recording.ts
 *
 * Options (env vars):
 *   PLAYGROUND_URL   — default http://localhost:3001
 *   TEST_PHRASE      — text to send via chat
 *   RECORD_SECONDS   — how long to record (default: 15)
 *   HEADED           — set to "false" for headless mode (default: true)
 */

import * as dotenv from "dotenv";
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const PLAYGROUND_URL = process.env.PLAYGROUND_URL ?? "http://localhost:3001";
const TEST_PHRASE =
  process.env.TEST_PHRASE ??
  "Hello! Can you tell me a short story about a robot learning to dance? Make it about three sentences long.";
const RECORD_SECONDS = parseInt(process.env.RECORD_SECONDS ?? "15", 10);
const HEADED = process.env.HEADED !== "false";

const OUTPUT_DIR = path.join(__dirname, "..", "test-results");

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  console.log(`\n--- Video Recording Test ---`);
  console.log(`Playground:     ${PLAYGROUND_URL}`);
  console.log(`Test phrase:    "${TEST_PHRASE}"`);
  console.log(`Record length:  ${RECORD_SECONDS}s`);
  console.log(`Output dir:     ${OUTPUT_DIR}\n`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    permissions: ["microphone"],
  });

  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("console", (msg) => {
    if (msg.text().startsWith("[test]")) console.log("       " + msg.text());
  });

  try {
    // Step 1: Open playground
    console.log("[1/6] Opening playground...");
    await page.goto(PLAYGROUND_URL, { waitUntil: "networkidle" });

    // Step 2: Connect
    console.log("[2/6] Connecting to room...");
    const connectBtn = page.locator('button:has-text("Connect")').first();
    await connectBtn.click();

    await page
      .locator('button:has-text("Disconnect")')
      .waitFor({ state: "visible", timeout: 30_000 });
    console.log("       Connected.");

    // Step 3: Wait for agent video
    console.log("[3/6] Waiting for agent video track...");
    await page
      .locator("video")
      .first()
      .waitFor({ state: "attached", timeout: 60_000 });
    console.log("       Agent video track received.");
    await page.waitForTimeout(2000);

    // Step 4: Send test phrase to trigger speech
    console.log("[4/6] Sending test phrase...");
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
    console.log("       Message sent, waiting for avatar to start speaking...");

    // Wait for the agent to start speaking so audio track is published
    await page.waitForTimeout(5000);

    // Step 5: Record the avatar's WebRTC stream directly
    console.log(`[5/6] Recording avatar stream for ${RECORD_SECONDS}s...`);

    // Start MediaRecorder inside the browser capturing the avatar's actual tracks
    const trackInfo = await page.evaluate(async (recordSeconds) => {
      // Find the video element that has the avatar stream
      const video = document.querySelector("video");
      if (!video) throw new Error("No video element found");

      const stream = new MediaStream();

      // Grab video track from the video element's srcObject
      const videoSrc = video.srcObject as MediaStream | null;
      if (videoSrc) {
        for (const track of videoSrc.getVideoTracks()) {
          stream.addTrack(track);
        }
      }

      // Grab audio from all <audio> elements (RoomAudioRenderer creates these for WebRTC audio)
      const audioElements = document.querySelectorAll("audio");
      const audioCtx = new AudioContext();
      const destination = audioCtx.createMediaStreamDestination();
      let audioSourceCount = 0;

      for (const audioEl of audioElements) {
        const audioSrc = audioEl.srcObject as MediaStream | null;
        if (audioSrc && audioSrc.getAudioTracks().length > 0) {
          const source = audioCtx.createMediaStreamSource(audioSrc);
          source.connect(destination);
          audioSourceCount++;
        }
      }

      if (audioSourceCount > 0) {
        for (const track of destination.stream.getAudioTracks()) {
          stream.addTrack(track);
        }
      }

      const hasVideo = stream.getVideoTracks().length > 0;
      const hasAudio = stream.getAudioTracks().length > 0;

      console.log(`[test] Stream tracks: ${stream.getVideoTracks().length} video, ${stream.getAudioTracks().length} audio`);

      if (!hasVideo) throw new Error("No video tracks found in avatar stream");

      // Record
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      // Start recording
      recorder.start(1000);

      // Wait for the specified duration
      await new Promise((resolve) => setTimeout(resolve, recordSeconds * 1000));

      // Stop and collect
      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: mimeType }));
        };
        recorder.stop();
      });

      // Close audio context
      await audioCtx.close();

      // Convert blob to array for transfer to Node
      const buf = await blob.arrayBuffer();
      const arr = Array.from(new Uint8Array(buf));

      return { data: arr, hasVideo, hasAudio, size: buf.byteLength };
    }, RECORD_SECONDS);

    console.log(`       Tracks captured: video=${trackInfo.hasVideo}, audio=${trackInfo.hasAudio}`);
    console.log(`       Raw blob size: ${(trackInfo.size / 1024 / 1024).toFixed(2)} MB`);

    // Step 6: Save to disk
    console.log("[6/6] Saving recording...");
    const filename = `avatar-recording-${timestamp}.webm`;
    const filePath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, Buffer.from(trackInfo.data));

    const fileSizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
    console.log(`       Video saved: ${filePath}`);
    console.log(`       File size: ${fileSizeMB} MB`);

    if (trackInfo.size < 1024) {
      console.error(`\n❌ FAIL: Recording is too small (${trackInfo.size} bytes).`);
      process.exit(1);
    }

    if (!trackInfo.hasAudio) {
      console.warn(`\n⚠️  WARNING: No audio track was captured. The agent may not have been speaking.`);
    }

    console.log(`\n✅ PASS: Avatar recording saved (${fileSizeMB} MB, video=${trackInfo.hasVideo}, audio=${trackInfo.hasAudio})`);
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
