import { Slider } from "@base-ui/react/slider";

interface Props {
  className?: string;
  "aria-label": string;
  disabled: boolean;
  value: number[];
  min: number;
  max: number;
  step: number;
  onValueChange(value: number | number[]): void;
}
/** A labeled single-thumb Base UI slider using the editor's shadcn styling. */
export function EffectSlider({ "aria-label": label, ...props }: Props) {
  return (
    <Slider.Root {...props} thumbAlignment="center">
      <Slider.Control className="relative flex w-full touch-none items-center select-none">
        <Slider.Track className="relative h-1 grow overflow-hidden rounded-full bg-muted">
          <Slider.Indicator className="h-full bg-primary" />
        </Slider.Track>
        <Slider.Thumb
          aria-label={label}
          className="relative block size-3 shrink-0 rounded-full border border-ring bg-white outline-none focus-visible:ring-3"
        />
      </Slider.Control>
    </Slider.Root>
  );
}
