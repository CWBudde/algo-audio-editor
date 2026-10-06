import type { EffectParameterDescriptor } from "@aae/protocol";
import { type PointerEvent, useRef } from "react";

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

/** A compact parameter controller; it never computes or processes audio. */
export function EffectKnob({
  parameter,
  value,
  disabled,
  onChange,
}: {
  parameter: EffectParameterDescriptor;
  value: number;
  disabled: boolean;
  onChange(value: number): void;
}) {
  const drag = useRef<{ pointer: number; x: number; y: number; position: number } | undefined>(
    undefined,
  );
  const logarithmic = parameter.scale === "log" && parameter.min > 0;
  const minimum = logarithmic ? Math.log(parameter.min) : parameter.min;
  const maximum = logarithmic ? Math.log(parameter.max) : parameter.max;
  const safeValue = Number.isFinite(value)
    ? clamp(value, parameter.min, parameter.max)
    : parameter.min;
  const position =
    ((logarithmic ? Math.log(safeValue) : safeValue) - minimum) / (maximum - minimum);
  const changePosition = (next: number) => {
    if (disabled) return;
    const scaled = minimum + clamp(next) * (maximum - minimum);
    const numeric = logarithmic ? Math.exp(scaled) : scaled;
    const stepped =
      parameter.step > 0
        ? parameter.min + Math.round((numeric - parameter.min) / parameter.step) * parameter.step
        : numeric;
    onChange(clamp(Number(stepped.toPrecision(7)), parameter.min, parameter.max));
  };
  const stop = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      role="slider"
      aria-label={`${parameter.label} knob`}
      aria-valuemin={parameter.min}
      aria-valuemax={parameter.max}
      aria-valuenow={safeValue}
      aria-valuetext={`${Number(safeValue.toPrecision(6))}${parameter.unit ? ` ${parameter.unit}` : ""}`}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      title="Drag up or right to increase; Shift for fine adjustment. Double-click to reset."
      className="mx-auto size-10 touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:opacity-50"
      data-disabled={disabled || undefined}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, position };
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointer !== event.pointerId) return;
        active.position = clamp(
          active.position +
            (event.clientX - active.x + active.y - event.clientY) / (event.shiftKey ? 1600 : 160),
        );
        active.x = event.clientX;
        active.y = event.clientY;
        changePosition(active.position);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={() => {
        drag.current = undefined;
      }}
      onDoubleClick={() => {
        if (!disabled) onChange(parameter.default);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        const step = logarithmic
          ? event.shiftKey
            ? 0.001
            : 0.01
          : Math.max(parameter.step, (maximum - minimum) / (event.shiftKey ? 1000 : 100)) /
            (maximum - minimum);
        let next: number;
        switch (event.key) {
          case "ArrowUp":
          case "ArrowRight":
            next = position + step;
            break;
          case "ArrowDown":
          case "ArrowLeft":
            next = position - step;
            break;
          case "PageUp":
            next = position + 0.1;
            break;
          case "PageDown":
            next = position - 0.1;
            break;
          case "Home":
            next = 0;
            break;
          case "End":
            next = 1;
            break;
          default:
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        changePosition(next);
      }}
    >
      <svg viewBox="0 0 48 48" aria-hidden="true" className="size-full cursor-ns-resize">
        <path
          d="M9.15 38.85A21 21 0 1 1 38.85 38.85"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-control-track"
        />
        <path
          d="M9.15 38.85A21 21 0 1 1 38.85 38.85"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          pathLength="1"
          strokeDasharray={`${clamp(position)} 1`}
          className="text-primary"
        />
        <circle cx="24" cy="24" r="16" className="fill-muted stroke-border" />
        <line
          x1="24"
          y1="12"
          x2="24"
          y2="18"
          stroke="currentColor"
          strokeWidth="2.5"
          className="text-waveform-peak"
          strokeLinecap="round"
          transform={`rotate(${-135 + clamp(position) * 270} 24 24)`}
        />
      </svg>
    </div>
  );
}
