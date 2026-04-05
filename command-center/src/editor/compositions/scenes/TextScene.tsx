import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { TextScene as TextSceneProps } from "../../types";

export const TextSceneComponent: React.FC<Omit<TextSceneProps, "id" | "type" | "durationInFrames" | "transition">> = ({
  heading,
  body,
  headingColor,
  bodyColor,
  textAlign,
  animation,
  backgroundColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const getAnimationStyle = (delay: number) => {
    if (animation === "none") return {};
    const progress = spring({ frame, fps, delay, config: { damping: 200 } });

    switch (animation) {
      case "fade":
        return { opacity: progress };
      case "slide-up":
        return {
          opacity: progress,
          transform: `translateY(${interpolate(progress, [0, 1], [50, 0])}px)`,
        };
      case "slide-left":
        return {
          opacity: progress,
          transform: `translateX(${interpolate(progress, [0, 1], [-60, 0])}px)`,
        };
      case "scale":
        return {
          opacity: progress,
          transform: `scale(${interpolate(progress, [0, 1], [0.8, 1])})`,
        };
      case "typewriter":
        return { opacity: 1 };
      default:
        return { opacity: progress };
    }
  };

  const displayBody =
    animation === "typewriter"
      ? body.slice(0, Math.floor(interpolate(frame, [5, fps * 2], [0, body.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })))
      : body;

  return (
    <AbsoluteFill
      style={{
        backgroundColor,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "10%",
      }}
    >
      {heading && (
        <div
          style={{
            color: headingColor,
            fontSize: 52,
            fontWeight: 700,
            textAlign,
            lineHeight: 1.2,
            marginBottom: 24,
            fontFamily: "Inter, system-ui, sans-serif",
            ...getAnimationStyle(0),
          }}
        >
          {heading}
        </div>
      )}
      <div
        style={{
          color: bodyColor,
          fontSize: 32,
          fontWeight: 400,
          textAlign,
          lineHeight: 1.6,
          fontFamily: "Inter, system-ui, sans-serif",
          ...getAnimationStyle(6),
        }}
      >
        {displayBody}
      </div>
    </AbsoluteFill>
  );
};
