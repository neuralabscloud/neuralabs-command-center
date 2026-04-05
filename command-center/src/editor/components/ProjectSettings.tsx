import { useEditor } from "../store";
import type { AspectRatio } from "../types";

export const ProjectSettings: React.FC = () => {
  const { state, dispatch } = useEditor();
  const { project } = state;

  return (
    <div className="project-settings">
      <div className="settings-row">
        <label className="settings-label">Project</label>
        <input
          className="field-input"
          value={project.name}
          onChange={(e) => dispatch({ type: "UPDATE_PROJECT", updates: { name: e.target.value } })}
        />
      </div>
      <div className="settings-row">
        <label className="settings-label">Format</label>
        <div className="aspect-buttons">
          {(["9:16", "16:9", "1:1"] as AspectRatio[]).map((ratio) => (
            <button
              key={ratio}
              className={`aspect-btn ${project.aspectRatio === ratio ? "active" : ""}`}
              onClick={() => dispatch({ type: "UPDATE_PROJECT", updates: { aspectRatio: ratio } })}
            >
              {ratio}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <label className="settings-label">FPS</label>
        <select
          className="field-select"
          value={project.fps}
          onChange={(e) => dispatch({ type: "UPDATE_PROJECT", updates: { fps: Number(e.target.value) } })}
        >
          <option value={24}>24</option>
          <option value={30}>30</option>
          <option value={60}>60</option>
        </select>
      </div>
      <div className="settings-row">
        <label className="settings-label">Export</label>
        <button
          className="export-btn"
          onClick={() => {
            const json = JSON.stringify(project, null, 2);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${project.name.replace(/\s+/g, "-").toLowerCase()}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export Project JSON
        </button>
      </div>
    </div>
  );
};
