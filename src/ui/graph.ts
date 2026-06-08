// Graph: schema types, messages, constants, and pure utilities for the
// interaction wiring editor.
import { Effect, Option, Queue, Schema as S, Stream } from "effect";
import { Mount } from "foldkit";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";

// SCHEMA

export const GraphNodeKind = S.Literals(["Gesture", "SurfaceCapability"]);
export type GraphNodeKind = typeof GraphNodeKind.Type;

export const GraphNode = S.Struct({
  id: S.String,
  kind: GraphNodeKind,
  label: S.String,
  x: S.Number,
  y: S.Number,
  maybeSurface: S.Option(S.String),
  maybeCapability: S.Option(S.String),
});
export type GraphNode = typeof GraphNode.Type;

export const GraphEdge = S.Struct({
  id: S.String,
  sourceNodeId: S.String,
  targetNodeId: S.String,
  ruleId: S.String,
});
export type GraphEdge = typeof GraphEdge.Type;

export const NotDraggingGraph = ts("NotDraggingGraph");
export const DraggingGraphNode = ts("DraggingGraphNode", {
  nodeId: S.String,
  offsetX: S.Number,
  offsetY: S.Number,
});
export const DraggingPaletteNode = ts("DraggingPaletteNode", {
  kind: GraphNodeKind,
  label: S.String,
  maybeSurface: S.Option(S.String),
  maybeCapability: S.Option(S.String),
  x: S.Number,
  y: S.Number,
  isInside: S.Boolean,
});
export const ConnectingGraphEdge = ts("ConnectingGraphEdge", {
  sourceNodeId: S.String,
  x: S.Number,
  y: S.Number,
  isInside: S.Boolean,
});
export const GraphDragState = S.Union([
  NotDraggingGraph,
  DraggingGraphNode,
  DraggingPaletteNode,
  ConnectingGraphEdge,
]);
export type GraphDragState = typeof GraphDragState.Type;

export const NodeContextMenu = ts("NodeContextMenu", {
  nodeId: S.String,
  x: S.Number,
  y: S.Number,
});
export const EdgeContextMenu = ts("EdgeContextMenu", {
  edgeId: S.String,
  x: S.Number,
  y: S.Number,
});
export const ContextMenuState = S.Union([NodeContextMenu, EdgeContextMenu]);
export type ContextMenuState = typeof ContextMenuState.Type;

// MESSAGES

export const PressedPaletteNode = m("PressedPaletteNode", {
  kind: GraphNodeKind,
  label: S.String,
  maybeSurface: S.Option(S.String),
  maybeCapability: S.Option(S.String),
  x: S.Number,
  y: S.Number,
});
export const PressedGraphNode = m("PressedGraphNode", {
  nodeId: S.String,
  x: S.Number,
  y: S.Number,
});
export const RemovedGraphNode = m("RemovedGraphNode", { nodeId: S.String });
export const PressedGraphHandle = m("PressedGraphHandle", {
  nodeId: S.String,
  x: S.Number,
  y: S.Number,
});
export const PressedGraphEdge = m("PressedGraphEdge", { edgeId: S.String });
export const MovedGraphPointer = m("MovedGraphPointer", {
  x: S.Number,
  y: S.Number,
  isInside: S.Boolean,
});
export const ReleasedGraphPointer = m("ReleasedGraphPointer", {
  x: S.Number,
  y: S.Number,
  isInside: S.Boolean,
});
export const DisconnectedGraphEdge = m("DisconnectedGraphEdge", { edgeId: S.String });
export const OpenedNodeContextMenu = m("OpenedNodeContextMenu", {
  nodeId: S.String,
  x: S.Number,
  y: S.Number,
});
export const OpenedEdgeContextMenu = m("OpenedEdgeContextMenu", {
  edgeId: S.String,
  x: S.Number,
  y: S.Number,
});
export const ClosedContextMenu = m("ClosedContextMenu");

// CONSTANTS

export const GRAPH_NODE_WIDTH = 220;
export const GRAPH_NODE_HEIGHT = 78;
export const GRAPH_SURFACE_WIDTH = 1040;
export const GRAPH_SURFACE_HEIGHT = 680;

// UTILITIES

export const graphGestureNodeId = (gesture: string): string => `gesture:${gesture}`;
export const graphCapabilityNodeId = (surface: string, capability: string): string =>
  `capability:${surface}:${capability}`;

export const graphNodeAtPoint = (
  nodes: ReadonlyArray<GraphNode>,
  point: Readonly<{ x: number; y: number }>,
): Option.Option<GraphNode> =>
  Option.fromNullishOr(
    nodes.find(
      (node) =>
        point.x >= node.x &&
        point.x <= node.x + GRAPH_NODE_WIDTH &&
        point.y >= node.y &&
        point.y <= node.y + GRAPH_NODE_HEIGHT,
    ),
  );

export const graphNodeById = (
  nodes: ReadonlyArray<GraphNode>,
  nodeId: string,
): Option.Option<GraphNode> =>
  Option.fromNullishOr(nodes.find((node) => node.id === nodeId));

export const nextGraphNodeId = (nodes: ReadonlyArray<GraphNode>, baseId: string): string => {
  if (!nodes.some((node) => node.id === baseId)) {
    return baseId;
  }
  let index = 2;
  while (nodes.some((node) => node.id === `${baseId}:${index}`)) {
    index += 1;
  }
  return `${baseId}:${index}`;
};

export const sourcePort = (node: GraphNode): Readonly<{ x: number; y: number }> => ({
  x: node.x + GRAPH_NODE_WIDTH,
  y: node.y + GRAPH_NODE_HEIGHT / 2,
});

export const targetPort = (node: GraphNode): Readonly<{ x: number; y: number }> => ({
  x: node.x,
  y: node.y + GRAPH_NODE_HEIGHT / 2,
});

export const edgePath = (
  from: Readonly<{ x: number; y: number }>,
  to: Readonly<{ x: number; y: number }>,
): string => {
  const curve = Math.max(120, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + curve} ${from.y}, ${to.x - curve} ${to.y}, ${to.x} ${to.y}`;
};

// MOUNT

export const TrackGraphSurface = Mount.defineStream(
  "TrackGraphSurface",
  PressedGraphNode,
  PressedGraphHandle,
  PressedGraphEdge,
  MovedGraphPointer,
  ReleasedGraphPointer,
  OpenedNodeContextMenu,
  OpenedEdgeContextMenu,
)((element) =>
  Stream.callback((queue) =>
    Effect.gen(function* () {
      if (!(element instanceof HTMLElement)) {
        return yield* Effect.never;
      }
      const localPoint = (event: PointerEvent) => {
        const rect = element.getBoundingClientRect();
        const x = event.clientX - rect.left + element.scrollLeft;
        const y = event.clientY - rect.top + element.scrollTop;
        return {
          x,
          y,
          isInside: x >= 0 && x <= GRAPH_SURFACE_WIDTH && y >= 0 && y <= GRAPH_SURFACE_HEIGHT,
        };
      };
      const contextMenu = (event: MouseEvent) => {
        event.preventDefault();
        if (!(event.target instanceof Element)) return;
        const maybeNode = event.target.closest("[data-graph-node-id]");
        const nodeId = maybeNode?.getAttribute("data-graph-node-id");
        if (nodeId !== null && nodeId !== undefined) {
          Queue.offerUnsafe(
            queue,
            OpenedNodeContextMenu({ nodeId, x: event.clientX, y: event.clientY }),
          );
          return;
        }
        const maybeEdge = event.target.closest("[data-graph-edge-id]");
        const edgeId = maybeEdge?.getAttribute("data-graph-edge-id");
        if (edgeId !== null && edgeId !== undefined) {
          Queue.offerUnsafe(
            queue,
            OpenedEdgeContextMenu({ edgeId, x: event.clientX, y: event.clientY }),
          );
        }
      };
      const pointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || !(event.target instanceof Element)) {
          return;
        }
        if (event.target.closest("[data-graph-remove-node-id]")) {
          return;
        }
        const point = localPoint(event);
        const maybeHandle = event.target.closest("[data-graph-handle-node-id]");
        const handleNodeId = maybeHandle?.getAttribute("data-graph-handle-node-id");
        if (handleNodeId !== null && handleNodeId !== undefined) {
          event.preventDefault();
          Queue.offerUnsafe(
            queue,
            PressedGraphHandle({ nodeId: handleNodeId, x: point.x, y: point.y }),
          );
          return;
        }
        const maybeEdge = event.target.closest("[data-graph-edge-id]");
        const edgeId = maybeEdge?.getAttribute("data-graph-edge-id");
        if (edgeId !== null && edgeId !== undefined) {
          event.preventDefault();
          Queue.offerUnsafe(queue, PressedGraphEdge({ edgeId }));
          return;
        }
        const maybeNode = event.target.closest("[data-graph-node-id]");
        const nodeId = maybeNode?.getAttribute("data-graph-node-id");
        if (nodeId !== null && nodeId !== undefined) {
          event.preventDefault();
          Queue.offerUnsafe(queue, PressedGraphNode({ nodeId, x: point.x, y: point.y }));
        }
      };
      const pointerMove = (event: PointerEvent) => {
        const point = localPoint(event);
        Queue.offerUnsafe(queue, MovedGraphPointer(point));
      };
      const pointerUp = (event: PointerEvent) => {
        const point = localPoint(event);
        Queue.offerUnsafe(queue, ReleasedGraphPointer(point));
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          element.addEventListener("pointerdown", pointerDown);
          element.addEventListener("contextmenu", contextMenu);
          window.addEventListener("pointermove", pointerMove);
          window.addEventListener("pointerup", pointerUp);
          return { pointerDown, contextMenu, pointerMove, pointerUp };
        }),
        (handlers) =>
          Effect.sync(() => {
            element.removeEventListener("pointerdown", handlers.pointerDown);
            element.removeEventListener("contextmenu", handlers.contextMenu);
            window.removeEventListener("pointermove", handlers.pointerMove);
            window.removeEventListener("pointerup", handlers.pointerUp);
          }),
      );
      return yield* Effect.never;
    }),
  ),
);
