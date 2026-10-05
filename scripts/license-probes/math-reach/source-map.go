// Command source-map reports declarations in the target-selected Go math sources.
// It does not assign a license to a function or establish legal clearance.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type declaration struct {
	Symbol string `json:"symbol"`
	Line   int    `json:"line"`
	Kind   string `json:"kind"`
}
type source struct {
	Path         string        `json:"path"`
	SHA256       string        `json:"sha256"`
	Notices      []string      `json:"notices"`
	Declarations []declaration `json:"declarations"`
}
type inventory struct {
	GoVersion string   `json:"goVersion"`
	GOOS      string   `json:"goos"`
	GOARCH    string   `json:"goarch"`
	Sources   []source `json:"sources"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	goroot := flag.String("goroot", "", "verified toolchain root")
	goos := flag.String("goos", "", "target OS")
	goarch := flag.String("goarch", "", "target architecture")
	flag.Parse()
	if *goroot == "" || *goos == "" || *goarch == "" || flag.NArg() != 0 {
		return fmt.Errorf("source-map: require --goroot --goos --goarch")
	}
	ctx := build.Default
	ctx.GOROOT, ctx.GOOS, ctx.GOARCH, ctx.CgoEnabled = *goroot, *goos, *goarch, false
	version, err := os.ReadFile(filepath.Join(*goroot, "VERSION"))
	if err != nil {
		return fmt.Errorf("source-map: version: %w", err)
	}
	if strings.Split(string(version), "\n")[0] != "go1.26.8" {
		return fmt.Errorf("source-map: unsupported toolchain")
	}
	out := inventory{GoVersion: "go1.26.8", GOOS: *goos, GOARCH: *goarch, Sources: []source{}}
	asm := regexp.MustCompile(`(?m)^TEXT\s+·([A-Za-z_][A-Za-z_0-9]*)\(SB\),`)
	for _, importPath := range []string{"math", "math/cmplx"} {
		pkg, err := ctx.ImportDir(filepath.Join(*goroot, "src", importPath), 0)
		if err != nil {
			return fmt.Errorf("source-map: select %s: %w", importPath, err)
		}
		files := append(append([]string{}, pkg.GoFiles...), pkg.SFiles...)
		sort.Strings(files)
		for _, name := range files {
			data, err := os.ReadFile(filepath.Join(pkg.Dir, name))
			if err != nil {
				return fmt.Errorf("source-map: read %s: %w", name, err)
			}
			hash := sha256.Sum256(data)
			s := source{Path: "src/" + importPath + "/" + name, SHA256: hex.EncodeToString(hash[:]), Notices: []string{}, Declarations: []declaration{}}
			text := string(data)
			if strings.HasSuffix(name, ".go") {
				fset := token.NewFileSet()
				f, err := parser.ParseFile(fset, name, data, parser.ParseComments)
				if err != nil {
					return fmt.Errorf("source-map: parse %s: %w", name, err)
				}
				comments := []string{}
				for _, group := range f.Comments {
					for _, comment := range group.List {
						comments = append(comments, comment.Text)
					}
				}
				s.Notices = sourceNotices(strings.Join(comments, "\n"))
				for _, decl := range f.Decls {
					fn, ok := decl.(*ast.FuncDecl)
					if !ok {
						continue
					}
					if fn.Recv != nil {
						return fmt.Errorf("source-map: unsupported math method in %s", name)
					}
					kind := "go-body"
					if fn.Body == nil {
						kind = "go-declaration"
					}
					s.Declarations = append(s.Declarations, declaration{importPath + "." + fn.Name.Name, fset.Position(fn.Pos()).Line, kind})
				}
			} else {
				comments := []string{}
				for _, line := range strings.Split(text, "\n") {
					if strings.HasPrefix(strings.TrimSpace(line), "//") {
						comments = append(comments, line)
					}
				}
				s.Notices = sourceNotices(strings.Join(comments, "\n"))
				for _, match := range asm.FindAllStringSubmatchIndex(text, -1) {
					s.Declarations = append(s.Declarations, declaration{importPath + "." + text[match[2]:match[3]], 1 + strings.Count(text[:match[0]], "\n"), "assembly-body"})
				}
				if len(s.Declarations) == 0 {
					return fmt.Errorf("source-map: unrecognized assembly TEXT in %s", name)
				}
			}
			out.Sources = append(out.Sources, s)
		}
	}
	return json.NewEncoder(os.Stdout).Encode(out)
}

func sourceNotices(comments string) []string {
	notices := []string{}
	if strings.Contains(comments, "SunPro") || strings.Contains(comments, "Sun Microsystems") {
		notices = append(notices, "SunPro")
	}
	if strings.Contains(comments, "Cephes Math Library") {
		notices = append(notices, "LicenseRef-Cephes")
	}
	return notices
}
