export type SceneType = "title" | "text" | "media" | "outro";

export type TextAlign = "left" | "center" | "right";
export type AnimationStyle = "fade" | "slide-up" | "slide-left" | "typewriter" | "scale" | "none";
export type TransitionType = "fade" | "slide" | "wipe" | "none";

export type AspectRatio = "16:9" | "9:16" | "1:1";

export const ASPECT_CONFIGS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

export type BaseScene = {
  id: string;
  type: SceneType;
  durationInFrames: number;
  transition: TransitionType;
  backgroundColor: string;
};

export type TitleScene = BaseScene & {
  type: "title";
  title: string;
  subtitle: string;
  titleColor: string;
  subtitleColor: string;
  titleSize: number;
  animation: AnimationStyle;
};

export type TextScene = BaseScene & {
  type: "text";
  heading: string;
  body: string;
  headingColor: string;
  bodyColor: string;
  textAlign: TextAlign;
  animation: AnimationStyle;
};

export type MediaScene = BaseScene & {
  type: "media";
  mediaSrc: string;
  mediaType: "image" | "video";
  overlayText: string;
  overlayColor: string;
  overlayPosition: "top" | "center" | "bottom";
  objectFit: "cover" | "contain";
};

export type OutroScene = BaseScene & {
  type: "outro";
  title: string;
  cta: string;
  titleColor: string;
  ctaColor: string;
  animation: AnimationStyle;
};

export type Scene = TitleScene | TextScene | MediaScene | OutroScene;

export type Project = {
  name: string;
  fps: number;
  aspectRatio: AspectRatio;
  scenes: Scene[];
  audioSrc: string | null;
  audioVolume: number;
};

export type EditorState = {
  project: Project;
  selectedSceneId: string | null;
  isPlaying: boolean;
  currentFrame: number;
};

export type EditorAction =
  | { type: "SET_PROJECT"; project: Project }
  | { type: "ADD_SCENE"; scene: Scene }
  | { type: "UPDATE_SCENE"; id: string; updates: Partial<Scene> }
  | { type: "REMOVE_SCENE"; id: string }
  | { type: "REORDER_SCENES"; fromIndex: number; toIndex: number }
  | { type: "SELECT_SCENE"; id: string | null }
  | { type: "SET_PLAYING"; isPlaying: boolean }
  | { type: "SET_FRAME"; frame: number }
  | { type: "UPDATE_PROJECT"; updates: Partial<Project> }
  | { type: "LOAD_TEMPLATE"; project: Project };
