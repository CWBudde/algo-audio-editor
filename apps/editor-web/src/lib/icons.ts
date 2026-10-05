import type { ComponentType, SVGProps } from "react";

/** SVG props owned by the editor, independent of the upstream icon library. */
export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

// Semantic action names keep call sites independent of Heroicons' artwork names.
// The pinned @heroicons/react package supplies the paths and its MIT grant.
export {
  AdjustmentsHorizontalIcon as Settings2,
  AdjustmentsHorizontalIcon as SlidersHorizontal,
  ArrowPathRoundedSquareIcon as Repeat2,
  ArrowsPointingOutIcon as Maximize2,
  ArrowUturnLeftIcon as Undo2,
  ArrowUturnRightIcon as Redo2,
  ClipboardDocumentIcon as ClipboardPaste,
  ClockIcon as History,
  CursorArrowRaysIcon as Magnet,
  DocumentDuplicateIcon as Copy,
  EllipsisHorizontalIcon as MoreHorizontal,
  FlagIcon as Flag,
  InformationCircleIcon as Info,
  MagnifyingGlassCircleIcon as ScanSearch,
  MagnifyingGlassMinusIcon as ZoomOut,
  MagnifyingGlassPlusIcon as ZoomIn,
  MusicalNoteIcon as FileAudio,
  PlayIcon as Play,
  QueueListIcon as ListMusic,
  RectangleGroupIcon as SquareDashed,
  ScissorsIcon as Scissors,
  StopIcon as Square,
  TrashIcon as Trash2,
  ViewfinderCircleIcon as Crop,
} from "@heroicons/react/24/outline";
