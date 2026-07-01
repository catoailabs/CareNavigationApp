import type { ConnectionLineComponent } from "@xyflow/react";

const HALF = 0.5;

export const Connection: ConnectionLineComponent = ({
  fromX,
  fromY,
  toX,
  toY,
}) => (
  <g>
    <path
      d={`M${fromX},${fromY} C ${fromX + (toX - fromX) * HALF},${fromY} ${fromX + (toX - fromX) * HALF},${toY} ${toX},${toY}`}
      fill="none"
      stroke="var(--color-ring)"
      strokeWidth={1.5}
      style={{
        strokeDasharray: "6 4",
        // Reuse React Flow's built-in dash keyframe so the live line flows.
        animation: "dashdraw 0.6s linear infinite",
      }}
    />
    <circle
      cx={toX}
      cy={toY}
      fill="var(--color-background)"
      r={3}
      stroke="var(--color-ring)"
      strokeWidth={1.5}
    />
  </g>
);
