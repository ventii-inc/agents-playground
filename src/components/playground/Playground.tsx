"use client";

import { LoadingSVG } from "@/components/button/LoadingSVG";
import { ChatTile } from "@/components/chat/ChatTile";
import { AttributesInspector } from "@/components/config/AttributesInspector";
import { AudioInputTile } from "@/components/config/AudioInputTile";
import { ConfigurationPanelItem } from "@/components/config/ConfigurationPanelItem";
import {
  EditableNameValueRow,
  NameValueRow,
} from "@/components/config/NameValueRow";
import { DebugPanel } from "@/components/debug";
import { PlaygroundHeader } from "@/components/playground/PlaygroundHeader";
import {
  PlaygroundTab,
  PlaygroundTabbedTile,
  PlaygroundTile,
} from "@/components/playground/PlaygroundTile";
import { useRemoteSession } from "@/hooks/useRemoteSession";
import { useConfig } from "@/hooks/useConfig";
import { useUplinkLatency } from "@/hooks/useUplinkLatency";
import { PartialMessage } from "@bufbuild/protobuf";
import {
  BarVisualizer,
  RoomAudioRenderer,
  SessionProvider,
  StartAudio,
  VideoTrack,
  useAgent,
  useParticipantAttributes,
  useSession,
  useSessionMessages,
} from "@livekit/components-react";
import {
  ConnectionState,
  TokenSourceConfigurable,
  TokenSourceFetchOptions,
  Track,
} from "livekit-client";
import { RoomAgentDispatch } from "livekit-server-sdk";
import { QRCodeSVG } from "qrcode.react";
import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useRecording } from "@/hooks/useRecording";
import tailwindTheme from "../../lib/tailwindTheme.preval";
import { RpcPanel } from "./RpcPanel";

export interface PlaygroundMeta {
  name: string;
  value: string;
}

export interface PlaygroundProps {
  logo?: ReactNode;
  themeColors: string[];
  tokenSource: TokenSourceConfigurable;
  agentOptions?: PartialMessage<RoomAgentDispatch>;
  autoConnect?: boolean;
}

const headerHeight = 56;

export default function Playground({
  logo,
  tokenSource,
  agentOptions: initialAgentOptions,
  autoConnect,
}: PlaygroundProps) {
  const { config } = useConfig();

  const [rpcMethod, setRpcMethod] = useState("");
  const [rpcPayload, setRpcPayload] = useState("");
  const [hasConnected, setHasConnected] = useState(false);

  const [tokenFetchOptions, setTokenFetchOptions] =
    useState<TokenSourceFetchOptions>();

  // initialize token fetch options from initial values, which can come from config
  useEffect(() => {
    if (tokenFetchOptions !== undefined || initialAgentOptions === undefined) {
      return;
    }
    setTokenFetchOptions({
      agentName: initialAgentOptions?.agentName ?? "",
      agentMetadata: initialAgentOptions?.metadata ?? "",
    });
  }, [
    tokenFetchOptions,
    initialAgentOptions,
    initialAgentOptions?.agentName,
    initialAgentOptions?.metadata,
  ]);

  const session = useSession(tokenSource, tokenFetchOptions);
  const { connectionState } = session;
  const agent = useAgent(session);
  const messages = useSessionMessages(session);

  const {
    events: clientEvents,
    overlappingSpeechEvents,
    sessionUsage,
    networkLatency,
    clearEvents,
    sendRequest,
  } = useRemoteSession(session.room);

  const uplinkLatency = useUplinkLatency(
    session.room,
    agent.internal.agentParticipant?.identity,
    sendRequest,
  );

  const { isRecording, duration: recordingDuration, toggleRecording, stopRecording } =
    useRecording(agent.cameraTrack, agent.microphoneTrack);

  const localScreenTrack = session.room.localParticipant.getTrackPublication(
    Track.Source.ScreenShare,
  );

  const startSession = useCallback(() => {
    if (session.isConnected) {
      return;
    }
    session.start();
    setHasConnected(true);
  }, [session]);

  useEffect(() => {
    if (autoConnect && !hasConnected) {
      startSession();
    }
  }, [autoConnect, hasConnected, startSession]);

  useEffect(() => {
    if (connectionState === ConnectionState.Connected) {
      session.room.localParticipant.setCameraEnabled(
        config.settings.inputs.camera,
      );
      // Always start with mic muted — user can unmute manually
      session.room.localParticipant.setMicrophoneEnabled(false);
    }
  }, [
    config.settings.inputs.camera,
    session.room.localParticipant,
    connectionState,
  ]);

  useEffect(() => {
    if (connectionState === ConnectionState.Disconnected) {
      clearEvents();
      stopRecording();
    }
  }, [connectionState, clearEvents, stopRecording]);

  const [showDebugPanel, setShowDebugPanel] = useState(false);

  useEffect(() => {
    if (connectionState === ConnectionState.Disconnected) {
      setShowDebugPanel(false);
    } else if (!showDebugPanel && clientEvents.length > 0) {
      setShowDebugPanel(true);
    }
  }, [connectionState, showDebugPanel, clientEvents.length]);

  const videoTileContent = useMemo(() => {
    const videoFitClassName = `object-${config.video_fit || "contain"}`;

    const disconnectedContent = (
      <div className="flex items-center justify-center text-gray-700 text-center w-full h-full">
        No agent video track. Connect to get started.
      </div>
    );

    const loadingContent = (
      <div className="flex flex-col items-center justify-center gap-2 text-gray-700 text-center h-full w-full">
        <LoadingSVG />
        Waiting for agent video track…
      </div>
    );

    const videoContent = agent.cameraTrack ? (
      <VideoTrack
        trackRef={agent.cameraTrack}
        className={`absolute top-1/2 -translate-y-1/2 ${videoFitClassName} object-position-center w-full h-full`}
      />
    ) : null;

    let content = null;
    if (connectionState === ConnectionState.Disconnected) {
      content = disconnectedContent;
    } else if (agent.cameraTrack) {
      content = videoContent;
    } else {
      content = loadingContent;
    }

    return (
      <div className="flex flex-col w-full grow text-gray-950 bg-black rounded-sm border border-gray-800 relative">
        {content}
      </div>
    );
  }, [agent.cameraTrack, config, connectionState]);

  useEffect(() => {
    document.body.style.setProperty(
      "--lk-theme-color",
      // @ts-ignore
      tailwindTheme.colors[config.settings.theme_color]["500"],
    );
    document.body.style.setProperty(
      "--lk-drop-shadow",
      `var(--lk-theme-color) 0px 0px 18px`,
    );
  }, [config.settings.theme_color]);

  const audioTileContent = useMemo(() => {
    const disconnectedContent = (
      <div className="flex flex-col items-center justify-center gap-2 text-gray-700 text-center w-full">
        No agent audio track. Connect to get started.
      </div>
    );

    const waitingContent = (
      <div className="flex flex-col items-center gap-2 text-gray-700 text-center w-full">
        <LoadingSVG />
        Waiting for agent audio track…
      </div>
    );

    const visualizerContent = (
      <div
        className={`flex items-center justify-center w-full h-48 [--lk-va-bar-width:30px] [--lk-va-bar-gap:20px] [--lk-fg:var(--lk-theme-color)]`}
      >
        <BarVisualizer
          state={agent.state}
          track={agent.microphoneTrack}
          barCount={5}
          options={{ minHeight: 20 }}
        />
      </div>
    );

    if (connectionState === ConnectionState.Disconnected) {
      return disconnectedContent;
    }

    if (!agent.microphoneTrack) {
      return waitingContent;
    }

    return visualizerContent;
  }, [agent.microphoneTrack, connectionState, agent.state]);

  const chatTileContent = useMemo(() => {
    if (agent.isConnected) {
      return (
        <ChatTile
          messages={messages.messages}
          accentColor={config.settings.theme_color}
          onSend={messages.send}
        />
      );
    }
    return <></>;
  }, [
    agent.isConnected,
    config.settings.theme_color,
    messages.messages,
    messages.send,
  ]);

  const handleRpcCall = useCallback(async () => {
    if (!agent.internal.agentParticipant) {
      throw new Error("No agent or room available");
    }

    const response = await session.room.localParticipant.performRpc({
      destinationIdentity: agent.internal.agentParticipant.identity,
      method: rpcMethod,
      payload: rpcPayload,
    });
    return response;
  }, [
    session.room.localParticipant,
    rpcMethod,
    rpcPayload,
    agent.internal.agentParticipant,
  ]);

const agentAttributes = useParticipantAttributes({
    participant: agent.internal.agentParticipant ?? undefined,
  });

  const quickInputs = useMemo(
    () => [
      "tell me a poem",
      "whats the capital of france",
      "one more",
      "say again",
      "count 1 to 5",
    ],
    [],
  );

  const settingsTileContent = useMemo(() => {
    return (
      <div className="flex flex-col h-full w-full items-start overflow-y-auto">
        {config.settings.inputs.mic && (
          <ConfigurationPanelItem
            title="Microphone"
            source={Track.Source.Microphone}
          >
            {session.local.microphoneTrack ? (
              <AudioInputTile trackRef={session.local.microphoneTrack} />
            ) : null}
          </ConfigurationPanelItem>
        )}

        {agent.isConnected && (
          <ConfigurationPanelItem title="Quick Input">
            <div className="flex flex-row flex-wrap gap-2">
              {quickInputs.map((text) => (
                <button
                  key={text}
                  onClick={() => messages.send(text)}
                  className={`text-xs px-2 py-1 rounded-sm border border-gray-800 bg-gray-900 text-${config.settings.theme_color}-500 hover:bg-${config.settings.theme_color}-950 hover:border-${config.settings.theme_color}-700 transition-colors`}
                >
                  {text}
                </button>
              ))}
            </div>
          </ConfigurationPanelItem>
        )}

        <ConfigurationPanelItem title="Room">
          <div className="flex flex-col gap-2">
            <NameValueRow
              name="Room name"
              value={
                connectionState === ConnectionState.Connected
                  ? session.room.name
                  : ""
              }
              valueColor={`${config.settings.theme_color}-500`}
            />
            <NameValueRow
              name="Status"
              value={
                connectionState === ConnectionState.Connecting ? (
                  <LoadingSVG diameter={16} strokeWidth={2} />
                ) : (
                  connectionState.charAt(0).toUpperCase() +
                  connectionState.slice(1)
                )
              }
              valueColor={
                connectionState === ConnectionState.Connected
                  ? `${config.settings.theme_color}-500`
                  : "gray-500"
              }
            />
          </div>
        </ConfigurationPanelItem>

        <ConfigurationPanelItem title="Agent">
          <div className="flex flex-col gap-2">
            <EditableNameValueRow
              name="Agent name"
              value={tokenFetchOptions?.agentName ?? ""}
              valueColor={`${config.settings.theme_color}-500`}
              onValueChange={(value) => {
                setTokenFetchOptions({
                  ...tokenFetchOptions,
                  agentName: value,
                });
              }}
              placeholder="None"
              editable={connectionState !== ConnectionState.Connected}
            />
            <NameValueRow
              name="Identity"
              value={
                agent.internal.agentParticipant ? (
                  agent.internal.agentParticipant.identity
                ) : connectionState === ConnectionState.Connected ? (
                  <LoadingSVG diameter={12} strokeWidth={2} />
                ) : (
                  "No agent connected"
                )
              }
              valueColor={
                agent.isConnected
                  ? `${config.settings.theme_color}-500`
                  : "gray-500"
              }
            />
            {connectionState === ConnectionState.Connected &&
              agent.internal.agentParticipant && (
                <AttributesInspector
                  attributes={Object.entries(
                    agentAttributes.attributes || {},
                  ).map(([key, value]) => ({
                    id: key,
                    key,
                    value: String(value),
                  }))}
                  onAttributesChange={() => {}}
                  themeColor={config.settings.theme_color}
                  disabled={true}
                />
              )}
            <p className="text-xs text-gray-500 text-right">
              Set an agent name to use{" "}
              <a
                href="https://docs.livekit.io/agents/server/agent-dispatch/#explicit"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-gray-300 underline"
              >
                explicit dispatch
              </a>
              .
            </p>
          </div>
        </ConfigurationPanelItem>

        {connectionState === ConnectionState.Connected &&
          config.settings.inputs.screen && (
            <ConfigurationPanelItem
              title="Screen"
              source={Track.Source.ScreenShare}
            >
              {localScreenTrack ? (
                <div className="relative">
                  <VideoTrack
                    className="rounded-sm border border-gray-800 opacity-70 w-full"
                    trackRef={
                      localScreenTrack
                        ? {
                            participant: session.room.localParticipant,
                            publication: localScreenTrack,
                            source: Track.Source.ScreenShare,
                          }
                        : undefined
                    }
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center text-gray-700 text-center w-full h-full">
                  Press the button above to share your screen.
                </div>
              )}
            </ConfigurationPanelItem>
          )}
        {connectionState === ConnectionState.Connected && agent.isConnected && (
          <RpcPanel
            config={config}
            rpcMethod={rpcMethod}
            rpcPayload={rpcPayload}
            setRpcMethod={setRpcMethod}
            setRpcPayload={setRpcPayload}
            handleRpcCall={handleRpcCall}
          />
        )}
        {config.settings.inputs.camera && (
          <ConfigurationPanelItem title="Camera" source={Track.Source.Camera}>
            {session.local.cameraTrack ? (
              <div className="relative">
                <VideoTrack
                  className="rounded-sm border border-gray-800 opacity-70 w-full"
                  trackRef={session.local.cameraTrack}
                />
              </div>
            ) : null}
          </ConfigurationPanelItem>
        )}
        {config.show_qr && (
          <div className="w-full">
            <ConfigurationPanelItem title="QR Code">
              <QRCodeSVG value={window.location.href} width="128" />
            </ConfigurationPanelItem>
          </div>
        )}
      </div>
    );
  }, [
    config,
    agent.isConnected,
    agentAttributes.attributes,
    session.room.name,
    connectionState,
    session.local.cameraTrack,
    localScreenTrack,
    session.local.microphoneTrack,
    agent.internal.agentParticipant,
    rpcMethod,
    rpcPayload,
    handleRpcCall,
    tokenFetchOptions,
    setTokenFetchOptions,
    quickInputs,
    messages,
  ]);

  let mobileTabs: PlaygroundTab[] = [];
  if (config.settings.outputs.video) {
    mobileTabs.push({
      title: "Video",
      content: (
        <PlaygroundTile
          className="w-full h-full grow"
          childrenClassName="justify-center"
        >
          {videoTileContent}
        </PlaygroundTile>
      ),
    });
  }

  if (config.settings.outputs.audio) {
    mobileTabs.push({
      title: "Audio",
      content: (
        <PlaygroundTile
          className="w-full h-full grow"
          childrenClassName="justify-center"
        >
          {audioTileContent}
        </PlaygroundTile>
      ),
    });
  }

  if (config.settings.chat) {
    mobileTabs.push({
      title: "Chat",
      content: chatTileContent,
    });
  }

  mobileTabs.push({
    title: "Settings",
    content: (
      <PlaygroundTile
        padding={false}
        backgroundColor="gray-950"
        className="h-full w-full basis-1/4 items-start overflow-y-auto flex"
        childrenClassName="h-full grow items-start"
      >
        {settingsTileContent}
      </PlaygroundTile>
    ),
  });

  return (
    <SessionProvider session={session}>
      <div className="flex flex-col h-full w-full">
        <PlaygroundHeader
          title={config.title}
          logo={logo}
          githubLink={config.github_link}
          height={headerHeight}
          accentColor={config.settings.theme_color}
          connectionState={connectionState}
          isRecording={isRecording}
          recordingDuration={recordingDuration}
          onRecordClicked={toggleRecording}
          onConnectClicked={() => {
            if (connectionState === ConnectionState.Disconnected) {
              startSession();
            } else if (connectionState === ConnectionState.Connected) {
              session.end();
            }
          }}
        />
        <div
          className={`flex gap-4 py-4 grow w-full overflow-hidden selection:bg-${config.settings.theme_color}-900`}
          style={{ minHeight: 0 }}
        >
          <div className="flex flex-col grow basis-1/2 gap-4 h-full lg:hidden">
            <PlaygroundTabbedTile
              className="h-full"
              tabs={mobileTabs}
              initialTab={mobileTabs.length - 1}
            />
          </div>
          <div
            className={`flex-col grow basis-1/2 gap-4 h-full hidden lg:${
              !config.settings.outputs.audio && !config.settings.outputs.video
                ? "hidden"
                : "flex"
            }`}
          >
            {config.settings.outputs.video && (
              <PlaygroundTile
                title="Agent Video"
                className="w-full h-full grow"
                childrenClassName="justify-center"
              >
                {videoTileContent}
              </PlaygroundTile>
            )}
            {config.settings.outputs.audio && (
              <PlaygroundTile
                title="Agent Audio"
                className="w-full h-full grow"
                childrenClassName="justify-center"
              >
                {audioTileContent}
              </PlaygroundTile>
            )}
          </div>

          {config.settings.chat && (
            <PlaygroundTile
              title="Chat"
              className="h-full grow basis-1/4 hidden lg:flex"
            >
              {chatTileContent}
            </PlaygroundTile>
          )}
          <PlaygroundTile
            padding={false}
            backgroundColor="gray-950"
            className="h-full w-full basis-1/4 items-start overflow-y-auto hidden max-w-[480px] lg:flex"
            childrenClassName="h-full grow items-start"
          >
            {settingsTileContent}
          </PlaygroundTile>
        </div>
        {showDebugPanel && (
          <DebugPanel
            userTrack={session.local.microphoneTrack?.publication?.track}
            agentTrack={agent.microphoneTrack?.publication?.track}
            events={clientEvents}
            overlappingSpeechEvents={overlappingSpeechEvents}
            sessionUsage={sessionUsage}
            onClearEvents={clearEvents}
            networkLatency={networkLatency}
            uplinkLatency={uplinkLatency}
          />
        )}
        <RoomAudioRenderer />
        <StartAudio label="Click to enable audio playback" />
      </div>
    </SessionProvider>
  );
}
