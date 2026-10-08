// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The TypeScript unions in next/tools/tygo.yaml's frontmatter are written
// by hand (tygo cannot derive them): every message type must be in
// ClientMessage or ServerMessage, and every reason/kind/code constant in
// its union, or the client compiles against an incomplete contract.
func TestTypeScriptUnions(t *testing.T) {
	fset := token.NewFileSet()
	var files []*ast.File
	entries, err := os.ReadDir(".")
	require.NoError(t, err)
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, e.Name(), nil, parser.SkipObjectResolution)
		require.NoError(t, err)
		files = append(files, f)
	}

	// The constant blocks, by one of their constants; each block's
	// constants with their string values.
	blockOf := func(name string) map[string]string {
		for _, f := range files {
			for _, d := range f.Decls {
				gd, ok := d.(*ast.GenDecl)
				if !ok || gd.Tok != token.CONST {
					continue
				}
				consts := map[string]string{}
				found := false
				for _, spec := range gd.Specs {
					vs := spec.(*ast.ValueSpec)
					for i, n := range vs.Names {
						if lit, ok := vs.Values[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
							consts[n.Name], err = strconv.Unquote(lit.Value)
							require.NoError(t, err)
						}
						found = found || n.Name == name
					}
				}
				if found {
					return consts
				}
			}
		}
		t.Fatalf("no constant block with %s", name)
		return nil
	}

	// Message structs by their type literal (tstype:"'hello'").
	structOf := map[string]string{}
	for _, f := range files {
		for _, d := range f.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok || gd.Tok != token.TYPE {
				continue
			}
			for _, spec := range gd.Specs {
				ts := spec.(*ast.TypeSpec)
				st, ok := ts.Type.(*ast.StructType)
				if !ok {
					continue
				}
				for _, field := range st.Fields.List {
					if id, ok := field.Type.(*ast.Ident); ok && id.Name == "MessageType" && len(field.Names) == 1 && field.Names[0].Name == "Type" && field.Tag != nil {
						tag, err := strconv.Unquote(field.Tag.Value)
						require.NoError(t, err)
						lit := reflect.StructTag(tag).Get("tstype")
						require.Regexp(t, `^'[a-z_]+'$`, lit, "%s.Type needs a literal tstype", ts.Name.Name)
						assert.NotContains(t, structOf, lit, "two messages of type %s", lit)
						structOf[strings.Trim(lit, "'")] = ts.Name.Name
					}
				}
			}
		}
	}
	messages := func(block map[string]string) []string {
		var res []string
		for name, typ := range block {
			s, ok := structOf[typ]
			if assert.True(t, ok, "no message struct for %s (%q)", name, typ) {
				res = append(res, s)
			}
		}
		return res
	}
	consts := func(blocks ...map[string]string) []string {
		var res []string
		for _, b := range blocks {
			for name := range b {
				res = append(res, "typeof "+name)
			}
		}
		return res
	}

	yaml, err := os.ReadFile("../../../next/tools/tygo.yaml")
	require.NoError(t, err)
	union := func(name string) []string {
		m := regexp.MustCompile(`export type ` + name + ` =([^;]*);`).FindSubmatch(yaml)
		require.NotNil(t, m, "no union %s in tygo.yaml", name)
		var res []string
		for part := range strings.SplitSeq(string(m[1]), "|") {
			if part = strings.Join(strings.Fields(part), " "); part != "" {
				res = append(res, part)
			}
		}
		return res
	}

	assert.ElementsMatch(t, messages(blockOf("MsgHello")), union("ClientMessage"))
	assert.ElementsMatch(t, messages(blockOf("MsgWelcome")), union("ServerMessage"))
	assert.ElementsMatch(t, consts(blockOf("RefusedForbidden")), union("RefusalReason"))
	assert.ElementsMatch(t, consts(blockOf("BootstrapCursorTrimmed"), blockOf("RebootstrapTriggerRepaired")), union("BootstrapReason"))
	assert.ElementsMatch(t, consts(blockOf("NoticeNewBuild")), union("NoticeKind"))
	assert.ElementsMatch(t, consts(blockOf("ErrorBadMessage")), union("ErrorCode"))
	assert.ElementsMatch(t, consts(blockOf("LogClosedForbidden")), union("LogClosedReason"))
	assert.ElementsMatch(t, consts(blockOf("ViewedViewed")), union("ViewedState"))
	assert.Len(t, slices.Concat(messages(blockOf("MsgHello")), messages(blockOf("MsgWelcome"))), len(structOf), "a message struct without a type constant")

	// The fields use the unions.
	for _, tc := range []struct {
		v     any
		field string
		union string
	}{
		{Refusal{}, "Reason", "RefusalReason"},
		{BootstrapRequiredMessage{}, "Reason", "BootstrapReason"},
		{NoticeMessage{}, "Kind", "NoticeKind"},
		{ErrorMessage{}, "Code", "ErrorCode"},
		{LogClosedMessage{}, "Reason", "LogClosedReason"},
		{APIViewedFiles{}, "Files", "{ [path: string]: ViewedState }"},
	} {
		f, ok := reflect.TypeOf(tc.v).FieldByName(tc.field)
		require.True(t, ok)
		assert.Equal(t, tc.union, f.Tag.Get("tstype"), "%T.%s", tc.v, tc.field)
	}
}
