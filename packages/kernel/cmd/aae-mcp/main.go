//go:build !js

// Command aae-mcp serves the native editor through stdio MCP.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/automation"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/mcpserver"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	var roots automation.WriteDirectories
	flag.Var(&roots, "allow-write", "existing output directory (repeatable; writes disabled by default)")
	speechModels := flag.String("speech-models", "", "speech model directory for generate_speech (fill it with `aae speech download`)")
	flag.Parse()
	if flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "aae-mcp: unexpected arguments; run --help")
		os.Exit(1)
	}
	policy, err := automation.NewFilePolicy(roots)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer policy.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	if err := mcpserver.New(policy, *speechModels).Run(ctx, &mcp.StdioTransport{}); err != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, "aae-mcp:", err)
		os.Exit(1)
	}
}
