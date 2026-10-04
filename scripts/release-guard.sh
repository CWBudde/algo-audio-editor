#!/usr/bin/env bash
#
# release-guard.sh — keeps this application's github.com/cwbudde/* siblings
# current and reports work that has piled up since the last tag.
#
# Why: in August 2026 the algo-* family drifted onto three algo-fft versions at
# once, while algo-fft's main sat 97 commits past its latest tag. No single
# upgrade could compile, and untangling it took a day. Two of the mistakes
# behind that apply to this repo, and each has a subcommand:
#
#   deps        a sibling dependency is behind its latest tag
#   unreleased  untagged work is accumulating on this branch
#
# The library-side release gate (gorelease API checks, tagging) lives in the
# algo-* library repos. This repo is an application at the top of the
# dependency graph; nothing imports it, so that gate does not apply here.
#
# The script fails closed: if a `go list` or `git` call it needs fails (proxy
# down, no network, broken module graph, shallow clone), it prints the error
# and exits non-zero instead of reporting a clean result.
#
# Usage (run `deps` from the Go module directory):
#   scripts/release-guard.sh deps        # sibling deps at their latest tags?
#   scripts/release-guard.sh unreleased  # untagged work sitting on this branch?
#
# Prefer the justfile wrappers: `just check-deps`, `just check-unreleased`.
#
# Exit status: 0 clean, 1 drift found, 2 usage error, 3 could not check.

set -euo pipefail

# Resolve siblings directly from their origin rather than through the public
# proxy, so a tag pushed minutes ago is already visible.
export GOPRIVATE="${GOPRIVATE:-github.com/cwbudde}"

SIBLING_PREFIX="github.com/cwbudde/"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() {
	red "  ✗ $*"
	FAILED=1
}
ok() { green "  ✓ $*"; }
warn() { yellow "  ! $*"; }

FAILED=0

ERRLOG=$(mktemp)
trap 'rm -f "$ERRLOG"' EXIT

# die reports that the check itself could not run, shows the captured stderr
# of the failing command and exits. An unverifiable check must never pass.
die() {
	red "  ✗ $*"
	if [ -s "$ERRLOG" ]; then
		sed 's/^/      /' "$ERRLOG"
	fi
	red "Could not complete the check; refusing to report a clean result."
	exit 3
}

# capture VAR CMD [ARGS...] runs CMD, stores its stdout in VAR and dies if CMD
# fails. It must be called directly, never inside $(...): there `exit` would
# only leave the subshell and the failure would be lost.
# Its locals carry a prefix so they cannot shadow the caller's VAR.
capture() {
	local __capture_var=$1
	shift
	local __capture_out
	if ! __capture_out=$("$@" 2>"$ERRLOG"); then
		die "\`$*\` failed"
	fi
	printf -v "$__capture_var" '%s' "$__capture_out"
}

cmd_deps() {
	echo "Checking sibling dependencies are at their latest tags…"

	# Every github.com/cwbudde/* module in the build list, direct or indirect.
	# Indirect ones matter too: a stale indirect pin is how an incompatible
	# algo-fft reached algo-acoustics through two different paths.
	local all
	capture all go list -m -f '{{if not .Main}}{{.Path}}{{end}}' all

	local mods=() path
	while IFS= read -r path; do
		if [[ $path == "$SIBLING_PREFIX"* ]]; then
			mods+=("$path")
		fi
	done <<<"$all"

	if [ "${#mods[@]}" -eq 0 ]; then
		ok "no ${SIBLING_PREFIX}* dependencies"
		return
	fi

	# `-u` resolves each module's latest tag; anything with an .Update is behind.
	# `-versions` is the cross-check: a module pinned at a tag always has at
	# least that tag in its version list, so an empty list means the lookup
	# silently failed (for example a proxy answering 404) and -u saw nothing.
	local out
	capture out go list -m -u -versions \
		-f '{{.Path}}|{{.Version}}|{{if .Update}}{{.Update.Version}}{{end}}|{{len .Versions}}|{{if .Error}}{{.Error.Err}}{{end}}' \
		"${mods[@]}"

	local mod version update nversions err checked=0
	while IFS='|' read -r mod version update nversions err; do
		[ -z "$mod" ] && continue
		checked=$((checked + 1))
		if [ -n "$err" ]; then
			die "$mod: $err"
		fi
		if ! [[ $nversions =~ ^[0-9]+$ ]]; then
			die "$mod: unexpected \`go list\` output: $mod|$version|$update|$nversions|$err"
		fi
		if [ "$nversions" -eq 0 ]; then
			die "$mod: no tagged versions found; the version lookup failed or the module is not on a tag"
		fi
		if [ -n "$update" ]; then
			fail "$mod $version -> $update"
		else
			ok "$mod $version"
		fi
	done <<<"$out"

	if [ "$checked" -ne "${#mods[@]}" ]; then
		die "expected ${#mods[@]} module(s) from \`go list -m -u\`, got $checked"
	fi

	if [ "$FAILED" -ne 0 ]; then
		echo
		red "Sibling dependencies are behind their latest tags."
		echo "Bump them with:  go get <module>@<version> && go mod tidy"
		echo "If a bump is deliberately deferred, say so in PLAN.md and re-run."
	fi
}

cmd_unreleased() {
	echo "Checking for untagged work on this branch…"

	local threshold=${UNRELEASED_THRESHOLD:-20}
	if ! [[ $threshold =~ ^[0-9]+$ ]]; then
		red "UNRELEASED_THRESHOLD must be a non-negative integer, got '$threshold'"
		exit 2
	fi

	# A shallow clone has neither all tags nor the full history, so any count
	# taken from it would be wrong in the reassuring direction.
	local shallow
	capture shallow git rev-parse --is-shallow-repository
	if [ "$shallow" != "false" ]; then
		die "shallow clone: tags and history are incomplete (fetch with fetch-depth: 0)"
	fi

	local tags tag
	capture tags git tag --list 'v*' --sort=-v:refname
	tag=${tags%%$'\n'*}

	local count
	if [ -z "$tag" ]; then
		# No tag yet is a known state for this app (PLAN.md: tag v0.1.0 once CI
		# is green), not drift. Report it on every run, but do not fail: nothing
		# downstream consumes this app's tags, and a failure here would only
		# re-file the same drift issue every week until the first release.
		capture count git rev-list --count HEAD
		warn "no v* tags yet: nothing has been released; all $count commit(s) on HEAD are untagged"
		return
	fi

	capture count git rev-list --count "${tag}..HEAD"
	if [ "$count" -eq 0 ]; then
		ok "HEAD is $tag"
		return
	fi

	# A handful of untagged commits is normal mid-development, so a small count
	# is only a warning. Past the threshold it fails, so the scheduled workflow
	# raises the same nag it raises for stale deps.
	local log
	capture log git log --oneline -5 "${tag}..HEAD"
	warn "$count commit(s) since $tag — consider cutting a release"
	local line
	while IFS= read -r line; do
		echo "      $line"
	done <<<"$log"
	if [ "$count" -gt 5 ]; then
		echo "      … and $((count - 5)) more"
	fi

	if [ "$count" -ge "$threshold" ]; then
		fail "$count commits is past the ${threshold}-commit threshold — release or explain why not"
	fi
}

# The subcommand runs as a plain statement, not inside `||` or `if`, so
# `set -e` stays in force for everything it calls. Verdicts travel through
# FAILED; tooling errors leave through die().
case "${1:-}" in
deps) cmd_deps ;;
unreleased) cmd_unreleased ;;
*)
	echo "usage: $0 {deps|unreleased}" >&2
	exit 2
	;;
esac

exit "$FAILED"
