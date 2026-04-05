import { useEditor } from "../store";
import type { Scene, AnimationStyle, TransitionType, TextAlign } from "../types";

const ANIMATIONS: { value: AnimationStyle; label: string }[] = [
  { value: "fade", label: "Fade In" },
  { value: "slide-up", label: "Slide Up" },
  { value: "slide-left", label: "Slide Left" },
  { value: "typewriter", label: "Typewriter" },
  { value: "scale", label: "Scale" },
  { value: "none", label: "None" },
];

const TRANSITIONS: { value: TransitionType; label: string }[] = [
  { value: "fade", label: "Fade" },
  { value: "slide", label: "Slide" },
  { value: "wipe", label: "Wipe" },
  { value: "none", label: "Cut" },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="color-input-wrap">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="color-swatch" />
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className="field-input color-text" />
    </div>
  );
}

export const SceneEditor: React.FC = () => {
  const { state, dispatch } = useEditor();
  const scene = state.project.scenes.find((s) => s.id === state.selectedSceneId);

  if (!scene) {
    return (
      <div className="scene-editor-panel">
        <div className="panel-header">PROPERTIES</div>
        <div className="empty-state">Select a scene to edit its properties</div>
      </div>
    );
  }

  const update = (updates: Partial<Scene>) => {
    dispatch({ type: "UPDATE_SCENE", id: scene.id, updates });
  };

  return (
    <div className="scene-editor-panel">
      <div className="panel-header">
        PROPERTIES
        <span className="panel-badge">{scene.type.toUpperCase()}</span>
      </div>

      <div className="fields-scroll">
        {/* Common fields */}
        <Field label="Duration (frames)">
          <input
            type="number"
            className="field-input"
            value={scene.durationInFrames}
            min={15}
            max={900}
            onChange={(e) => update({ durationInFrames: Number(e.target.value) })}
          />
        </Field>

        <Field label="Duration (seconds)">
          <span className="field-value">
            {(scene.durationInFrames / state.project.fps).toFixed(2)}s
          </span>
        </Field>

        <Field label="Background">
          <ColorInput value={scene.backgroundColor} onChange={(v) => update({ backgroundColor: v })} />
        </Field>

        <Field label="Transition">
          <select
            className="field-select"
            value={scene.transition}
            onChange={(e) => update({ transition: e.target.value as TransitionType })}
          >
            {TRANSITIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </Field>

        <div className="field-divider" />

        {/* Title scene fields */}
        {scene.type === "title" && (
          <>
            <Field label="Title">
              <textarea
                className="field-input field-textarea"
                value={scene.title}
                onChange={(e) => update({ title: e.target.value })}
              />
            </Field>
            <Field label="Subtitle">
              <input
                className="field-input"
                value={scene.subtitle}
                onChange={(e) => update({ subtitle: e.target.value })}
              />
            </Field>
            <Field label="Title Color">
              <ColorInput value={scene.titleColor} onChange={(v) => update({ titleColor: v })} />
            </Field>
            <Field label="Subtitle Color">
              <ColorInput value={scene.subtitleColor} onChange={(v) => update({ subtitleColor: v })} />
            </Field>
            <Field label="Title Size">
              <input
                type="range"
                className="field-range"
                min={32}
                max={120}
                value={scene.titleSize}
                onChange={(e) => update({ titleSize: Number(e.target.value) })}
              />
              <span className="field-value">{scene.titleSize}px</span>
            </Field>
            <Field label="Animation">
              <select
                className="field-select"
                value={scene.animation}
                onChange={(e) => update({ animation: e.target.value as AnimationStyle })}
              >
                {ANIMATIONS.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </Field>
          </>
        )}

        {/* Text scene fields */}
        {scene.type === "text" && (
          <>
            <Field label="Heading">
              <input
                className="field-input"
                value={scene.heading}
                onChange={(e) => update({ heading: e.target.value })}
              />
            </Field>
            <Field label="Body">
              <textarea
                className="field-input field-textarea"
                rows={4}
                value={scene.body}
                onChange={(e) => update({ body: e.target.value })}
              />
            </Field>
            <Field label="Heading Color">
              <ColorInput value={scene.headingColor} onChange={(v) => update({ headingColor: v })} />
            </Field>
            <Field label="Body Color">
              <ColorInput value={scene.bodyColor} onChange={(v) => update({ bodyColor: v })} />
            </Field>
            <Field label="Text Align">
              <select
                className="field-select"
                value={scene.textAlign}
                onChange={(e) => update({ textAlign: e.target.value as TextAlign })}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </Field>
            <Field label="Animation">
              <select
                className="field-select"
                value={scene.animation}
                onChange={(e) => update({ animation: e.target.value as AnimationStyle })}
              >
                {ANIMATIONS.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </Field>
          </>
        )}

        {/* Media scene fields */}
        {scene.type === "media" && (
          <>
            <Field label="Media URL">
              <input
                className="field-input"
                placeholder="Paste image or video URL..."
                value={scene.mediaSrc}
                onChange={(e) => update({ mediaSrc: e.target.value })}
              />
            </Field>
            <Field label="Media Type">
              <select
                className="field-select"
                value={scene.mediaType}
                onChange={(e) => update({ mediaType: e.target.value as "image" | "video" })}
              >
                <option value="image">Image</option>
                <option value="video">Video</option>
              </select>
            </Field>
            <Field label="Fit">
              <select
                className="field-select"
                value={scene.objectFit}
                onChange={(e) => update({ objectFit: e.target.value as "cover" | "contain" })}
              >
                <option value="cover">Cover</option>
                <option value="contain">Contain</option>
              </select>
            </Field>
            <Field label="Overlay Text">
              <input
                className="field-input"
                value={scene.overlayText}
                onChange={(e) => update({ overlayText: e.target.value })}
              />
            </Field>
            <Field label="Overlay Color">
              <ColorInput value={scene.overlayColor} onChange={(v) => update({ overlayColor: v })} />
            </Field>
            <Field label="Overlay Position">
              <select
                className="field-select"
                value={scene.overlayPosition}
                onChange={(e) => update({ overlayPosition: e.target.value as "top" | "center" | "bottom" })}
              >
                <option value="top">Top</option>
                <option value="center">Center</option>
                <option value="bottom">Bottom</option>
              </select>
            </Field>
          </>
        )}

        {/* Outro scene fields */}
        {scene.type === "outro" && (
          <>
            <Field label="Title">
              <input
                className="field-input"
                value={scene.title}
                onChange={(e) => update({ title: e.target.value })}
              />
            </Field>
            <Field label="CTA Text">
              <input
                className="field-input"
                value={scene.cta}
                onChange={(e) => update({ cta: e.target.value })}
              />
            </Field>
            <Field label="Title Color">
              <ColorInput value={scene.titleColor} onChange={(v) => update({ titleColor: v })} />
            </Field>
            <Field label="CTA Color">
              <ColorInput value={scene.ctaColor} onChange={(v) => update({ ctaColor: v })} />
            </Field>
            <Field label="Animation">
              <select
                className="field-select"
                value={scene.animation}
                onChange={(e) => update({ animation: e.target.value as AnimationStyle })}
              >
                {ANIMATIONS.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </Field>
          </>
        )}
      </div>
    </div>
  );
};
