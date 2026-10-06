// Explicit redirect opt-in; never read or persist microphone activation in cookies.
export function microphoneStartsEnabled(hash: string): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return params.get("mic") === "1" && params.get("mic_unmuted") === "1";
}

export function createMicrophoneStartup(
  enabled: boolean,
  setEnabled: (enabled: boolean) => Promise<unknown>,
) {
  let applied = false;
  return async (state: string): Promise<void> => {
    if (state === "disconnected") applied = false;
    if (state !== "connected" || applied) return;
    applied = true;
    await setEnabled(enabled);
  };
}
