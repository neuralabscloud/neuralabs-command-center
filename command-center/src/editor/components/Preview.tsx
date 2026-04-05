import { Player, type PlayerRef } from "@remotion/player";
import { useCallback, useEffect, useRef } from "react";
import { VideoComposition } from "../compositions/VideoComposition";
import { useEditor } from "../store";
import { ASPECT_CONFIGS } from "../types";

export const Preview: React.FC = () => {
  const { state, dispatch } = useEditor();
  const { project } = state;
  const playerRef = useRef<PlayerRef>(null);

  const config = ASPECT_CONFIGS[project.aspectRatio];
  const totalFrames = project.scenes.reduce((sum, s) => sum + s.durationInFrames, 0) || 1;

  const handleFrameChange = useCallback(() => {
    const player = playerRef.current;
    if (player) {
      const frame = player.getCurrentFrame();
      dispatch({ type: "SET_FRAME", frame });
    }
  }, [dispatch]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.addEventListener("frameupdate", handleFrameChange);
    return () => player.removeEventListener("frameupdate", handleFrameChange);
  }, [handleFrameChange]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000",
          borderRadius: 10,
          overflow: "hidden",
          border: "1px solid #1a2540",
          minHeight: 0,
        }}
      >
        <Player
          ref={playerRef}
          component={VideoComposition}
          inputProps={{ project }}
          compositionWidth={config.width}
          compositionHeight={config.height}
          durationInFrames={totalFrames}
          fps={project.fps}
          style={{
            width: "100%",
            maxHeight: "100%",
            aspectRatio: `${config.width}/${config.height}`,
          }}
          controls
          autoPlay={false}
          loop
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 4px",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: "#64748b",
        }}
      >
        <span>
          Frame {state.currentFrame} / {totalFrames}
        </span>
        <span>
          {(state.currentFrame / project.fps).toFixed(1)}s /{" "}
          {(totalFrames / project.fps).toFixed(1)}s
        </span>
        <span>
          {config.width}x{config.height} @ {project.fps}fps
        </span>
      </div>
    </div>
  );
};
