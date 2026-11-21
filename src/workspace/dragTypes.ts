/**
 * What the file tree's drag carries (components/FileTree.tsx): the dragged
 * entry's path under this type, and its name as plain text. A note's editor
 * reads the same type, so a file dragged from the tree becomes a link to it
 * (views/note/editor/imageFiles.ts). Kept apart from the component so the
 * editor's chunk doesn't load the tree.
 */
export const FILE_DRAG_TYPE = 'application/x-nebula-path';
