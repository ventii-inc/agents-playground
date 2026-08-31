"use client";

import { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * MediaRecorder writes a live-streamable container, so it can never go back and
 * patch the header once recording ends. For WebM that means no Duration and no
 * Cues element — players show no length and cannot seek. Chrome's MP4 muxer
 * emits a real `moov` with duration, so prefer MP4 and keep WebM as a fallback.
 * H.264 + AAC first: Opus-in-MP4 will not open in QuickTime or Safari.
 */
const MIME_PREFERENCE = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,opus",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm",
];

function pickMimeType(): string {
  return (
    MIME_PREFERENCE.find((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm"
  );
}

export function useRecording(
  videoTrack?: TrackReferenceOrPlaceholder,
  audioTrack?: TrackReferenceOrPlaceholder,
) {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Audio is mixed through a WebAudio destination node so the recorded
  // MediaStream's track set never changes — mutating it would make the
  // MediaRecorder stop immediately and emit an empty file.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const connectAudio = useCallback((msTrack?: MediaStreamTrack) => {
    const ctx = audioCtxRef.current;
    const dest = destRef.current;
    if (!ctx || !dest) return;

    sourceRef.current?.disconnect();
    sourceRef.current = null;

    if (!msTrack) return;
    const source = ctx.createMediaStreamSource(new MediaStream([msTrack]));
    source.connect(dest);
    sourceRef.current = source;
  }, []);

  // Swap the agent's audio into the mix when it becomes available or changes
  useEffect(() => {
    if (!isRecording) return;
    connectAudio(audioTrack?.publication?.track?.mediaStreamTrack);
  }, [audioTrack?.publication?.track?.mediaStreamTrack, isRecording, connectAudio]);

  const startRecording = useCallback(() => {
    const videoMSTrack = videoTrack?.publication?.track?.mediaStreamTrack;
    if (!videoMSTrack) {
      console.warn("No video track available to record");
      return;
    }

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    destRef.current = ctx.createMediaStreamDestination();
    connectAudio(audioTrack?.publication?.track?.mediaStreamTrack);

    const stream = new MediaStream([
      videoMSTrack,
      ...destRef.current.stream.getAudioTracks(),
    ]);

    const mimeType = pickMimeType();

    const recorder = new MediaRecorder(stream, { mimeType });
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };

    recorder.onstop = () => {
      const chunks = chunksRef.current;
      chunksRef.current = [];

      sourceRef.current?.disconnect();
      sourceRef.current = null;
      destRef.current = null;
      audioCtxRef.current?.close();
      audioCtxRef.current = null;

      if (chunks.length === 0) {
        console.warn("Recording produced no data — nothing to download");
        return;
      }

      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
      a.download = `avatar-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    recorder.start(1000); // collect data every second
    recorderRef.current = recorder;
    setIsRecording(true);
    setDuration(0);

    timerRef.current = setInterval(() => {
      setDuration((d) => d + 1);
    }, 1000);
  }, [videoTrack, audioTrack, connectAudio]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop(); // onstop flushes the file and tears down audio
    }
    recorderRef.current = null;
    setIsRecording(false);

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setDuration(0);
  }, []);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  return { isRecording, duration, toggleRecording, startRecording, stopRecording };
}
