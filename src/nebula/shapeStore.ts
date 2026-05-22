import { useCallback, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Shape } from '../types/shapes';

export interface ShapeStoreMethods {
  createShape: (canvasId: string, shape: Shape) => Promise<void>;
  updateShape: (canvasId: string, shapeId: string, updates: Partial<Shape>) => Promise<void>;
  deleteShape: (canvasId: string, shapeId: string) => Promise<void>;
  batchUpdateShapes: (
    canvasId: string,
    updates: Array<{ shapeId: string; updates: Partial<Shape> }>
  ) => Promise<void>;
}

function sortShapes(shapes: Shape[]): Shape[] {
  return [...shapes].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
}

export function createLocalShapeStore(setShapes: Dispatch<SetStateAction<Shape[]>>): ShapeStoreMethods {
  return {
    async createShape(_canvasId, shape) {
      setShapes(previousShapes => sortShapes([...previousShapes.filter(existing => existing.id !== shape.id), shape]));
    },

    async updateShape(_canvasId, shapeId, updates) {
      setShapes(previousShapes =>
        sortShapes(
          previousShapes.map(shape =>
            shape.id === shapeId
              ? {
                  ...shape,
                  ...updates,
                  id: shape.id,
                }
              : shape
          )
        )
      );
    },

    async deleteShape(_canvasId, shapeId) {
      setShapes(previousShapes => previousShapes.filter(shape => shape.id !== shapeId));
    },

    async batchUpdateShapes(_canvasId, updates) {
      const updatesById = new Map(updates.map(update => [update.shapeId, update.updates]));
      setShapes(previousShapes =>
        sortShapes(
          previousShapes.map(shape => {
            const shapeUpdates = updatesById.get(shape.id);
            return shapeUpdates
              ? {
                  ...shape,
                  ...shapeUpdates,
                  id: shape.id,
                }
              : shape;
          })
        )
      );
    },
  };
}

export function useLocalShapeStore(setShapes: Dispatch<SetStateAction<Shape[]>>): ShapeStoreMethods {
  const createShape = useCallback<ShapeStoreMethods['createShape']>(
    async (_canvasId, shape) => {
      setShapes(previousShapes => sortShapes([...previousShapes.filter(existing => existing.id !== shape.id), shape]));
    },
    [setShapes]
  );

  const updateShape = useCallback<ShapeStoreMethods['updateShape']>(
    async (_canvasId, shapeId, updates) => {
      setShapes(previousShapes =>
        sortShapes(
          previousShapes.map(shape =>
            shape.id === shapeId
              ? {
                  ...shape,
                  ...updates,
                  id: shape.id,
                }
              : shape
          )
        )
      );
    },
    [setShapes]
  );

  const deleteShape = useCallback<ShapeStoreMethods['deleteShape']>(
    async (_canvasId, shapeId) => {
      setShapes(previousShapes => previousShapes.filter(shape => shape.id !== shapeId));
    },
    [setShapes]
  );

  const batchUpdateShapes = useCallback<ShapeStoreMethods['batchUpdateShapes']>(
    async (_canvasId, updates) => {
      const updatesById = new Map(updates.map(update => [update.shapeId, update.updates]));
      setShapes(previousShapes =>
        sortShapes(
          previousShapes.map(shape => {
            const shapeUpdates = updatesById.get(shape.id);
            return shapeUpdates
              ? {
                  ...shape,
                  ...shapeUpdates,
                  id: shape.id,
                }
              : shape;
          })
        )
      );
    },
    [setShapes]
  );

  return useMemo(
    () => ({ createShape, updateShape, deleteShape, batchUpdateShapes }),
    [createShape, updateShape, deleteShape, batchUpdateShapes]
  );
}
