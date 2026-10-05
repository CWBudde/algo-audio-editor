import { Button } from "@/components/ui/button";
import type { IconComponent } from "@/lib/icons";

interface IconActionProps {
  icon: IconComponent;
  label: string;
  shortcutLabel?: string;
  ariaShortcut?: string;
  disabled?: boolean;
  onClick(): void;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  testId?: string;
}

/** Compact action with a persistent accessible name and a native shortcut tooltip. */
export function IconAction({
  icon: Icon,
  label,
  shortcutLabel,
  ariaShortcut,
  disabled,
  onClick,
  variant = "ghost",
  testId,
}: IconActionProps) {
  return (
    <Button
      size="icon-sm"
      variant={variant}
      aria-label={label}
      aria-keyshortcuts={ariaShortcut}
      title={shortcutLabel ? `${label} (${shortcutLabel})` : label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}
