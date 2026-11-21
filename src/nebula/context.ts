/**
 * What a canvas is told about where it lives: the project it belongs to (the
 * shell keys its library collections by it) and the canvas file within it.
 * The workspace gives the project's id and the file's path.
 */
export type NebulaContext = {
  /** The project the canvas belongs to. */
  boardId: string;
  /** The canvas within the project. */
  canvasId: string;
};
