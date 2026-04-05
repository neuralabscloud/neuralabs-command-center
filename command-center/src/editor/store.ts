import { createContext, useContext } from "react";
import type { EditorState, EditorAction, Project, Scene } from "./types";

export function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const defaultProject: Project = {
  name: "Untitled Project",
  fps: 30,
  aspectRatio: "9:16",
  scenes: [],
  audioSrc: null,
  audioVolume: 0.8,
};

export const initialState: EditorState = {
  project: defaultProject,
  selectedSceneId: null,
  isPlaying: false,
  currentFrame: 0,
};

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "SET_PROJECT":
      return { ...state, project: action.project, selectedSceneId: null, currentFrame: 0 };

    case "ADD_SCENE":
      return {
        ...state,
        project: { ...state.project, scenes: [...state.project.scenes, action.scene] },
        selectedSceneId: action.scene.id,
      };

    case "UPDATE_SCENE":
      return {
        ...state,
        project: {
          ...state.project,
          scenes: state.project.scenes.map((s) =>
            s.id === action.id ? ({ ...s, ...action.updates } as Scene) : s
          ),
        },
      };

    case "REMOVE_SCENE": {
      const scenes = state.project.scenes.filter((s) => s.id !== action.id);
      return {
        ...state,
        project: { ...state.project, scenes },
        selectedSceneId:
          state.selectedSceneId === action.id
            ? scenes.length > 0
              ? scenes[0].id
              : null
            : state.selectedSceneId,
      };
    }

    case "REORDER_SCENES": {
      const scenes = [...state.project.scenes];
      const [moved] = scenes.splice(action.fromIndex, 1);
      scenes.splice(action.toIndex, 0, moved);
      return { ...state, project: { ...state.project, scenes } };
    }

    case "SELECT_SCENE":
      return { ...state, selectedSceneId: action.id };

    case "SET_PLAYING":
      return { ...state, isPlaying: action.isPlaying };

    case "SET_FRAME":
      return { ...state, currentFrame: action.frame };

    case "UPDATE_PROJECT":
      return { ...state, project: { ...state.project, ...action.updates } };

    case "LOAD_TEMPLATE":
      return { ...state, project: action.project, selectedSceneId: null, currentFrame: 0 };

    default:
      return state;
  }
}

export type EditorContextType = {
  state: EditorState;
  dispatch: React.Dispatch<EditorAction>;
};

export const EditorContext = createContext<EditorContextType | null>(null);

export function useEditor(): EditorContextType {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used within EditorProvider");
  return ctx;
}
