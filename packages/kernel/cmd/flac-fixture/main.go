// Command flac-fixture writes the one-hour kernel import acceptance fixture.
package main

import (
	"fmt"
	"os"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/testaudio"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("usage: flac-fixture OUTPUT.flac")
	}
	file, err := os.OpenFile(os.Args[1], os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600) // #nosec G703 -- This opt-in CLI intentionally creates the explicitly supplied output path, with O_EXCL preventing replacement.
	if err != nil {
		return fmt.Errorf("flac-fixture: create: %w", err)
	}
	defer func() { _ = file.Close() }()
	if err := testaudio.WriteFLAC(file, testaudio.HourFrames); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("flac-fixture: close: %w", err)
	}
	return nil
}
