"use client";

import { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import { useCallback, useEffect, useRef, useState } from "react";

export function useRecording(
  videoTrack?: TrackReferenceOrPlaceholder,
  audioTrack?: TrackReferenceOrPlaceholder,
) {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Sync audio track into the active recording stream when it becomes available
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream || !isRecording) return;

    const audioMSTrack = audioTrack?.publication?.track?.mediaStreamTrack;

    // Remove any stale audio tracks
    for (const t of stream.getAudioTracks()) {
      stream.removeTrack(t);
    }

    // Add the current audio track if available
    if (audioMSTrack) {
      stream.addTrack(audioMSTrack);
    }
  }, [audioTrack?.publication?.track?.mediaStreamTrack, isRecording]);

  const startRecording = useCallback(() => {
    const stream = new MediaStream();

    const videoMSTrack = videoTrack?.publication?.track?.mediaStreamTrack;
    const audioMSTrack = audioTrack?.publication?.track?.mediaStreamTrack;

    if (!videoMSTrack) {
      console.warn("No video track available to record");
      return;
    }

    stream.addTrack(videoMSTrack);
    if (audioMSTrack) {
      stream.addTrack(audioMSTrack);
    }

    streamRef.current = stream;

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm";

    const recorder = new MediaRecorder(stream, { mimeType });
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `avatar-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      chunksRef.current = [];
    };

    recorder.start(1000); // collect data every second
    recorderRef.current = recorder;
    setIsRecording(true);
    setDuration(0);

    timerRef.current = setInterval(() => {
      setDuration((d) => d + 1);
    }, 1000);
  }, [videoTrack, audioTrack]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    streamRef.current = null;
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
