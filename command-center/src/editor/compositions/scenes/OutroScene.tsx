import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { OutroScene as OutroSceneProps } from "../../types";

export const OutroSceneComponent: React.FC<Omit<OutroSceneProps, "id" | "type" | "durationInFrames" | "transition">> = ({
  title,
  cta,
  titleColor,
  ctaColor,
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
          transform: `translateY(${interpolate(progress, [0, 1], [40, 0])}px)`,
        };
      case "scale":
        return {
          opacity: progress,
          transform: `scale(${interpolate(progress, [0, 1], [0.6, 1])})`,
        };
      default:
        return { opacity: progress };
    }
  };

  const pulseScale = interpolate(
    Math.sin(frame * 0.1),
    [-1, 1],
    [0.98, 1.02]
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "10%",
        gap: 40,
      }}
    >
      <div
        style={{
          color: titleColor,
          fontSize: 56,
          fontWeight: 800,
          textAlign: "center",
          fontFamily: "Inter, system-ui, sans-serif",
          ...getAnimationStyle(0),
        }}
      >
        {title}
      </div>
      {cta && (
        <div
          style={{
            color: ctaColor,
            fontSize: 28,
            fontWeight: 600,
            textAlign: "center",
            padding: "16px 48px",
            border: `3px solid ${ctaColor}`,
            borderRadius: 60,
            fontFamily: "Inter, system-ui, sans-serif",
            transform: `scale(${pulseScale})`,
            ...getAnimationStyle(10),
          }}
        >
          {cta}
        </div>
      )}
    </AbsoluteFill>
  );
};
