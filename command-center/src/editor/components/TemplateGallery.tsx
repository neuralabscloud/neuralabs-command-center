import { useEditor } from "../store";
import { templates } from "../templates";

const ICONS: Record<string, string> = {
  chart: "📊",
  book: "📚",
  zap: "⚡",
  megaphone: "📢",
};

export const TemplateGallery: React.FC = () => {
  const { dispatch } = useEditor();

  return (
    <div className="template-gallery">
      <div className="panel-header">TEMPLATES</div>
      <div className="template-grid">
        {templates.map((tpl) => (
          <button
            key={tpl.id}
            className="template-card"
            onClick={() => dispatch({ type: "LOAD_TEMPLATE", project: tpl.create() })}
          >
            <div className="template-icon">{ICONS[tpl.icon] || "🎬"}</div>
            <div className="template-name">{tpl.name}</div>
            <div className="template-desc">{tpl.description}</div>
            <div className="template-ratio">{tpl.aspectRatio}</div>
          </button>
        ))}
      </div>
    </div>
  );
};
