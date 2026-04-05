import { useEditor } from "../store";
import { generateId } from "../store";
import type { Scene, SceneType } from "../types";

const SCENE_COLORS: Record<SceneType, string> = {
  title: "#a855f7",
  text: "#00e5ff",
  media: "#00ffaa",
  outro: "#ffaa22",
};

const SCENE_ICONS: Record<SceneType, string> = {
  title: "T",
  text: "Aa",
  media: "▶",
  outro: "✦",
};

function createDefaultScene(type: SceneType): Scene {
  const base = {
    id: generateId(),
    durationInFrames: 90,
    transition: "fade" as const,
    backgroundColor: "#0a0e17",
  };

  switch (type) {
    case "title":
      return {
        ...base,
        type: "title",
        title: "Your Title",
        subtitle: "Subtitle here",
        titleColor: "#00e5ff",
        subtitleColor: "#64748b",
        titleSize: 72,
        animation: "slide-up",
      };
    case "text":
      return {
        ...base,
        type: "text",
        durationInFrames: 120,
        heading: "Heading",
        body: "Your content goes here",
        headingColor: "#00e5ff",
        bodyColor: "#e2e8f0",
        textAlign: "left",
        animation: "slide-up",
      };
    case "media":
      return {
        ...base,
        type: "media",
        durationInFrames: 120,
        mediaSrc: "",
        mediaType: "image",
        overlayText: "",
        overlayColor: "#ffffff",
        overlayPosition: "bottom",
        objectFit: "cover",
      };
    case "outro":
      return {
        ...base,
        type: "outro",
        title: "Thanks for Watching",
        cta: "FOLLOW",
        titleColor: "#e2e8f0",
        ctaColor: "#a855f7",
        animation: "scale",
      };
  }
}

export const Timeline: React.FC = () => {
  const { state, dispatch } = useEditor();
  const { project, selectedSceneId } = state;
  const totalFrames = project.scenes.reduce((sum, s) => sum + s.durationInFrames, 0);

  return (
    <div className="timeline-panel">
      <div className="timeline-header">
        <span className="timeline-title">TIMELINE</span>
        <span className="timeline-duration">
          {(totalFrames / project.fps).toFixed(1)}s ({totalFrames} frames)
        </span>
      </div>

      <div className="timeline-scenes">
        {project.scenes.map((scene, index) => {
          const widthPct = totalFrames > 0 ? (scene.durationInFrames / totalFrames) * 100 : 100;
          return (
            <div
              key={scene.id}
              className={`timeline-scene ${selectedSceneId === scene.id ? "selected" : ""}`}
              style={{
                width: `${Math.max(widthPct, 8)}%`,
                borderLeftColor: SCENE_COLORS[scene.type],
              }}
              onClick={() => dispatch({ type: "SELECT_SCENE", id: scene.id })}
            >
              <span className="scene-icon" style={{ color: SCENE_COLORS[scene.type] }}>
                {SCENE_ICONS[scene.type]}
              </span>
              <span className="scene-label">
                {scene.type === "title" || scene.type === "outro"
                  ? scene.title.slice(0, 20)
                  : scene.type === "text"
                    ? scene.heading.slice(0, 20) || scene.body.slice(0, 20)
                    : "Media"}
              </span>
              <span className="scene-time">
                {(scene.durationInFrames / project.fps).toFixed(1)}s
              </span>
              <button
                className="scene-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "REMOVE_SCENE", id: scene.id });
                }}
                title="Remove scene"
              >
                ×
              </button>
              {index > 0 && (
                <button
                  className="scene-move-left"
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch({ type: "REORDER_SCENES", fromIndex: index, toIndex: index - 1 });
                  }}
                  title="Move left"
                >
                  ‹
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="timeline-add-row">
        <span className="add-label">ADD SCENE</span>
        {(["title", "text", "media", "outro"] as SceneType[]).map((type) => (
          <button
            key={type}
            className="add-scene-btn"
            style={{ borderColor: SCENE_COLORS[type], color: SCENE_COLORS[type] }}
            onClick={() => dispatch({ type: "ADD_SCENE", scene: createDefaultScene(type) })}
          >
            <span>{SCENE_ICONS[type]}</span>
            {type}
          </button>
        ))}
      </div>
    </div>
  );
};
