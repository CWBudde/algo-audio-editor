// Command demo-build regenerates the bundled public-domain demo using upstream DSP.
package main

import (
	"fmt"
	"os"

	"github.com/cwbudde/algo-dsp/dsp/core"
	"github.com/cwbudde/algo-dsp/dsp/signal"
	"github.com/cwbudde/wav"
	"github.com/go-audio/audio"
)

func main() {
	if err := generate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func generate() error {
	const rate = 48000
	const frames = 4 * rate
	gen := signal.NewGenerator(core.WithSampleRate(rate))
	left, err := gen.Sine(440, 0.125, frames)
	if err != nil {
		return fmt.Errorf("demo: left tone: %w", err)
	}
	right, err := gen.Sine(660, 0.125, frames)
	if err != nil {
		return fmt.Errorf("demo: right tone: %w", err)
	}
	data := make([]float32, 2*frames)
	for i := range frames {
		data[2*i], data[2*i+1] = float32(left[i]), float32(right[i])
	}
	file, err := os.Create("../../apps/editor-web/public/demo.wav")
	if err != nil {
		return fmt.Errorf("demo: create: %w", err)
	}
	defer func() { _ = file.Close() }()
	encoder := wav.NewEncoder(file, rate, 16, 2, 1)
	if err := encoder.Write(&audio.Float32Buffer{Data: data, Format: &audio.Format{SampleRate: rate, NumChannels: 2}}); err != nil {
		return fmt.Errorf("demo: encode: %w", err)
	}
	if err := encoder.Close(); err != nil {
		return fmt.Errorf("demo: finalize: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("demo: close: %w", err)
	}
	return nil
}
