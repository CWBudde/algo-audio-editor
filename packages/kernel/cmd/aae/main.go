//go:build !js

// Command aae applies editor operations to native audio files.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/automation"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	if err := automation.RunCLI(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
