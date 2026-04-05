import { useReducer, useState } from "react";
import { EditorContext, editorReducer, initialState } from "./store";
import { Preview } from "./components/Preview";
import { Timeline } from "./components/Timeline";
import { SceneEditor } from "./components/SceneEditor";
import { TemplateGallery } from "./components/TemplateGallery";
import { ProjectSettings } from "./components/ProjectSettings";

type Tab = "properties" | "templates" | "settings";

export const App: React.FC = () => {
  const [state, dispatch] = useReducer(editorReducer, initialState);
  const [activeTab, setActiveTab] = useState<Tab>("templates");
  const [dismissedWelcome, setDismissedWelcome] = useState(false);

  const hasScenes = state.project.scenes.length > 0;
  const showWelcome = !hasScenes && !dismissedWelcome;

  return (
    <EditorContext value={{ state, dispatch }}>
      <div className="editor-layout">
        {/* Left: Preview */}
        <div className="editor-preview">
          <Preview />
        </div>

        {/* Right: Controls */}
        <div className="editor-controls">
          <div className="tab-bar">
            <button
              className={`tab-btn ${activeTab === "properties" ? "active" : ""}`}
              onClick={() => setActiveTab("properties")}
            >
              Properties
            </button>
            <button
              className={`tab-btn ${activeTab === "templates" ? "active" : ""}`}
              onClick={() => setActiveTab("templates")}
            >
              Templates
            </button>
            <button
              className={`tab-btn ${activeTab === "settings" ? "active" : ""}`}
              onClick={() => setActiveTab("settings")}
            >
              Settings
            </button>
          </div>

          <div className="tab-content">
            {activeTab === "properties" && <SceneEditor />}
            {activeTab === "templates" && <TemplateGallery />}
            {activeTab === "settings" && <ProjectSettings />}
          </div>
        </div>
      </div>

      {/* Bottom: Timeline */}
      <div className="editor-timeline">
        <Timeline />
      </div>

      {/* Welcome overlay when no scenes */}
      {showWelcome && (
        <div
          className="welcome-overlay"
          onClick={() => {
            setDismissedWelcome(true);
            setActiveTab("templates");
          }}
        >
          <div className="welcome-content">
            <div className="welcome-icon">🎬</div>
            <div className="welcome-title">VIDEO EDITOR</div>
            <div className="welcome-sub">Click to start — pick a template or add scenes</div>
          </div>
        </div>
      )}
    </EditorContext>
  );
};
