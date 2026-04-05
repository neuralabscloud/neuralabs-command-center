import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { TitleScene as TitleSceneProps } from "../../types";

export const TitleSceneComponent: React.FC<Omit<TitleSceneProps, "id" | "type" | "durationInFrames" | "transition">> = ({
  title,
  subtitle,
  titleColor,
  subtitleColor,
  titleSize,
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
          transform: `translateY(${interpolate(progress, [0, 1], [60, 0])}px)`,
        };
      case "slide-left":
        return {
          opacity: progress,
          transform: `translateX(${interpolate(progress, [0, 1], [-80, 0])}px)`,
        };
      case "scale":
        return {
          opacity: progress,
          transform: `scale(${interpolate(progress, [0, 1], [0.5, 1])})`,
        };
      case "typewriter":
        return { opacity: 1 };
      default:
        return { opacity: progress };
    }
  };

  const displayTitle =
    animation === "typewriter"
      ? title.slice(0, Math.floor(interpolate(frame, [0, fps * 1.5], [0, title.length], { extrapolateRight: "clamp" })))
      : title;

  return (
    <AbsoluteFill
      style={{
        backgroundColor,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "10%",
      }}
    >
      <div
        style={{
          color: titleColor,
          fontSize: titleSize,
          fontWeight: 800,
          textAlign: "center",
          lineHeight: 1.1,
          fontFamily: "Inter, system-ui, sans-serif",
          ...getAnimationStyle(0),
        }}
      >
        {displayTitle}
      </div>
      {subtitle && (
        <div
          style={{
            color: subtitleColor,
            fontSize: titleSize * 0.4,
            fontWeight: 400,
            textAlign: "center",
            marginTop: titleSize * 0.3,
            fontFamily: "Inter, system-ui, sans-serif",
            ...getAnimationStyle(8),
          }}
        >
          {subtitle}
        </div>
      )}
    </AbsoluteFill>
  );
};
