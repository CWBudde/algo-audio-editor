// Command protocol-schema extracts the wire shape of the Go protocol for the
// frontend parity test and the Go schema-hash pin. It parses source only,
// without compiling the kernel.
//
// Every payload field is reported with its JSON name and how encoding/json
// writes it:
//
//   - kind: string, number, boolean, array, record (maps), object (structs) or
//     unknown (any, interfaces, json.RawMessage).
//   - optional: the key can be absent (omitempty or omitzero). encoding/json
//     never omits a non-pointer struct under omitempty, so that stays required.
//   - nullable: the field is a pointer without omitempty/omitzero, the
//     protocol's only deliberate way to write null. Slices and maps also write
//     null when nil, but the engine allocates them for every non-omitempty
//     field; the shared golden files pin that convention instead.
//
// The hash covers methods and payload shapes, not the version, so a shape
// change without a protocol.Version bump is detectable.
package main

import (
	"crypto/sha256"
	"encoding/hex"
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

// Field is one JSON key of a payload.
type Field struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Optional bool   `json:"optional"`
	Nullable bool   `json:"nullable"`
}

type schema struct {
	Methods  []string           `json:"methods"`
	Payloads map[string][]Field `json:"payloads"`
}

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
	resolve := func(expr ast.Expr) ast.Expr {
		for {
			ident, ok := expr.(*ast.Ident)
			if !ok || types[ident.Name] == nil {
				return expr
			}
			expr = types[ident.Name]
		}
	}
	var kind func(ast.Expr) string
	kind = func(expr ast.Expr) string {
		switch value := expr.(type) {
		case *ast.Ident:
			switch value.Name {
			case "string":
				return "string"
			case "bool":
				return "boolean"
			case "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32",
				"uint64", "uintptr", "byte", "rune", "float32", "float64":
				return "number"
			}
			if next := types[value.Name]; next != nil {
				return kind(next)
			}
			return "unknown"
		case *ast.StarExpr:
			return kind(value.X)
		case *ast.ArrayType:
			if ident, ok := value.Elt.(*ast.Ident); ok && (ident.Name == "byte" || ident.Name == "uint8") {
				return "string" // encoding/json writes []byte as base64.
			}
			return "array"
		case *ast.MapType:
			return "record"
		case *ast.StructType:
			return "object"
		}
		return "unknown" // any, interfaces and json.RawMessage.
	}
	var fields func(ast.Expr) []Field
	fields = func(expr ast.Expr) []Field {
		structure, ok := resolve(expr).(*ast.StructType)
		if !ok {
			return nil
		}
		direct, embedded := []Field{}, []Field{}
		for _, field := range structure.Fields.List {
			if field.Tag == nil {
				if len(field.Names) == 0 {
					inner := field.Type
					pointer := false
					if star, ok := inner.(*ast.StarExpr); ok {
						inner, pointer = star.X, true
					}
					for _, promoted := range fields(inner) {
						// A nil embedded pointer drops every promoted key.
						promoted.Optional = promoted.Optional || pointer
						embedded = append(embedded, promoted)
					}
				}
				continue
			}
			tag, err := strconv.Unquote(field.Tag.Value)
			if err != nil {
				panic(err)
			}
			options := strings.Split(reflect.StructTag(tag).Get("json"), ",")
			if options[0] == "-" || len(field.Names) == 0 && options[0] == "" {
				continue
			}
			names := []string{options[0]}
			if options[0] == "" {
				names = names[:0]
				for _, name := range field.Names {
					names = append(names, name.Name)
				}
			}
			omitEmpty := slices.Contains(options[1:], "omitempty")
			omitZero := slices.Contains(options[1:], "omitzero")
			_, pointer := field.Type.(*ast.StarExpr)
			fieldKind := kind(field.Type)
			if slices.Contains(options[1:], "string") {
				fieldKind = "string"
			}
			_, structValue := resolve(field.Type).(*ast.StructType)
			for _, name := range names {
				direct = append(direct, Field{
					Name:     name,
					Kind:     fieldKind,
					Optional: omitZero || omitEmpty && !structValue,
					Nullable: pointer && !omitEmpty && !omitZero,
				})
			}
		}
		// Shallower keys hide promoted keys of the same name, as in encoding/json.
		for _, promoted := range embedded {
			if !slices.ContainsFunc(direct, func(field Field) bool { return field.Name == promoted.Name }) {
				direct = append(direct, promoted)
			}
		}
		slices.SortFunc(direct, func(a, b Field) int { return strings.Compare(a.Name, b.Name) })
		return direct
	}
	payloads := make(map[string][]Field)
	for name, expr := range types {
		if shape := fields(expr); shape != nil {
			payloads[name] = shape
		}
	}
	slices.Sort(methods)
	pinned, err := json.Marshal(schema{methods, payloads})
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(pinned)
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Version string `json:"version"`
		Hash    string `json:"hash"`
		schema
	}{version, hex.EncodeToString(sum[:]), schema{methods, payloads}}); err != nil {
		panic(err)
	}
}
