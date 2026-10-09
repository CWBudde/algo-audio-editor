//go:build !(js && wasm)

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "speech: build with GOOS=js GOARCH=wasm; natively use aae --speech-models")
	os.Exit(2)
}
