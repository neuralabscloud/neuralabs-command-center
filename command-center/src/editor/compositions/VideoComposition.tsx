import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { Project, Scene } from "../types";
import { TitleSceneComponent } from "./scenes/TitleScene";
import { TextSceneComponent } from "./scenes/TextScene";
import { MediaSceneComponent } from "./scenes/MediaScene";
import { OutroSceneComponent } from "./scenes/OutroScene";

export type VideoCompositionProps = {
  project: Project;
};

function renderScene(scene: Scene) {
  switch (scene.type) {
    case "title":
      return (
        <TitleSceneComponent
          title={scene.title}
          subtitle={scene.subtitle}
          titleColor={scene.titleColor}
          subtitleColor={scene.subtitleColor}
          titleSize={scene.titleSize}
          animation={scene.animation}
          backgroundColor={scene.backgroundColor}
        />
      );
    case "text":
      return (
        <TextSceneComponent
          heading={scene.heading}
          body={scene.body}
          headingColor={scene.headingColor}
          bodyColor={scene.bodyColor}
          textAlign={scene.textAlign}
          animation={scene.animation}
          backgroundColor={scene.backgroundColor}
        />
      );
    case "media":
      return (
        <MediaSceneComponent
          mediaSrc={scene.mediaSrc}
          mediaType={scene.mediaType}
          overlayText={scene.overlayText}
          overlayColor={scene.overlayColor}
          overlayPosition={scene.overlayPosition}
          objectFit={scene.objectFit}
          backgroundColor={scene.backgroundColor}
        />
      );
    case "outro":
      return (
        <OutroSceneComponent
          title={scene.title}
          cta={scene.cta}
          titleColor={scene.titleColor}
          ctaColor={scene.ctaColor}
          animation={scene.animation}
          backgroundColor={scene.backgroundColor}
        />
      );
  }
}

export const VideoComposition: React.FC<VideoCompositionProps> = ({ project }) => {
  const { fps } = useVideoConfig();

  if (project.scenes.length === 0) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "#06080d",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "Inter, system-ui, sans-serif",
          color: "#64748b",
          fontSize: 24,
        }}
      >
        Add a scene to get started
      </AbsoluteFill>
    );
  }

  let currentFrame = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#06080d" }}>
      {project.scenes.map((scene) => {
        const from = currentFrame;
        currentFrame += scene.durationInFrames;
        return (
          <Sequence
            key={scene.id}
            from={from}
            durationInFrames={scene.durationInFrames}
            premountFor={Math.round(fps * 0.5)}
          >
            {renderScene(scene)}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
