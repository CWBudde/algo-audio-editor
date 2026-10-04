// Command protocol-schema extracts the wire names from the Go protocol for the
// frontend parity test. It parses source only, without compiling the kernel.
package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
)

func main() {
	files, err := filepath.Glob(filepath.Join(os.Args[1], "*.go"))
	if err != nil {
		panic(err)
	}
	types := make(map[string]ast.Expr)
	methods := []string{}
	version := ""
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			panic(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch spec := node.(type) {
			case *ast.TypeSpec:
				types[spec.Name.Name] = spec.Type
			case *ast.ValueSpec:
				for i, name := range spec.Names {
					if i >= len(spec.Values) {
						continue
					}
					literal, ok := spec.Values[i].(*ast.BasicLit)
					if !ok {
						continue
					}
					if name.Name == "Version" {
						version = literal.Value
					}
					if strings.HasPrefix(name.Name, "Method") {
						method, err := strconv.Unquote(literal.Value)
						if err != nil {
							panic(err)
						}
						methods = append(methods, method)
					}
				}
			}
			return true
		})
	}
	var fields func(ast.Expr) []string
	fields = func(expr ast.Expr) []string {
		switch value := expr.(type) {
		case *ast.Ident:
			return fields(types[value.Name])
		case *ast.StructType:
			result := []string{}
			for _, field := range value.Fields.List {
				if field.Tag != nil {
					tag, err := strconv.Unquote(field.Tag.Value)
					if err != nil {
						panic(err)
					}
					name := strings.Split(reflect.StructTag(tag).Get("json"), ",")[0]
					if name != "" && name != "-" {
						result = append(result, name)
					}
				} else if len(field.Names) == 0 {
					result = append(result, fields(field.Type)...)
				}
			}
			slices.Sort(result)
			return slices.Compact(result)
		}
		return nil
	}
	payloads := make(map[string][]string)
	for name, expr := range types {
		if names := fields(expr); names != nil {
			payloads[name] = names
		}
	}
	slices.Sort(methods)
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Version  string              `json:"version"`
		Methods  []string            `json:"methods"`
		Payloads map[string][]string `json:"payloads"`
	}{version, methods, payloads}); err != nil {
		panic(err)
	}
}
