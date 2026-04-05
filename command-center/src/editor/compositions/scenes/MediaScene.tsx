import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { MediaScene as MediaSceneProps } from "../../types";

export const MediaSceneComponent: React.FC<Omit<MediaSceneProps, "id" | "type" | "durationInFrames" | "transition">> = ({
  mediaSrc,
  mediaType,
  overlayText,
  overlayColor,
  overlayPosition,
  objectFit,
  backgroundColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const textProgress = spring({ frame, fps, delay: 5, config: { damping: 200 } });
  const zoomProgress = interpolate(frame, [0, fps * 3], [1, 1.05], {
    extrapolateRight: "clamp",
  });

  const positionStyles: Record<string, React.CSSProperties> = {
    top: { top: "8%", left: "50%", transform: "translateX(-50%)" },
    center: { top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
    bottom: { bottom: "8%", left: "50%", transform: "translateX(-50%)" },
  };

  return (
    <AbsoluteFill style={{ backgroundColor }}>
      {mediaSrc && mediaType === "image" && (
        <Img
          src={mediaSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit,
            transform: `scale(${zoomProgress})`,
          }}
        />
      )}
      {mediaSrc && mediaType === "video" && (
        <video
          src={mediaSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit,
            transform: `scale(${zoomProgress})`,
          }}
          muted
        />
      )}
      {overlayText && (
        <div
          style={{
            position: "absolute",
            ...positionStyles[overlayPosition],
            color: overlayColor,
            fontSize: 44,
            fontWeight: 700,
            textAlign: "center",
            padding: "16px 32px",
            background: "rgba(0,0,0,0.6)",
            borderRadius: 12,
            fontFamily: "Inter, system-ui, sans-serif",
            opacity: textProgress,
            maxWidth: "80%",
          }}
        >
          {overlayText}
        </div>
      )}
    </AbsoluteFill>
  );
};
