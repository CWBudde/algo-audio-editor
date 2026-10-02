// Package buildinfo carries version metadata stamped in at link time.
//
// The justfile sets both variables with
//
//	-ldflags "-X github.com/cwbudde/algo-audio-editor/packages/kernel/internal/buildinfo.Version=..."
//
// The -X path must match this package's import path exactly; a mismatch is
// silently ignored by the linker and leaves the defaults in place.
package buildinfo

// Version is the kernel version, normally the output of `git describe`.
var Version = "dev"

// BuildTime is the UTC build timestamp in RFC 3339 form, empty when unset.
var BuildTime = ""
