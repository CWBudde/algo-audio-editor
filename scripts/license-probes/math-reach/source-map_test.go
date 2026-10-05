package main

import (
	"reflect"
	"testing"
)

func TestSourceNotices(t *testing.T) {
	for _, tc := range []struct {
		name, comments string
		want           []string
	}{
		{"GoBSD", "Copyright The Go Authors. Use of this source code is governed by a BSD-style license.", []string{}},
		{"SunPro", "Developed at SunPro, a Sun Microsystems, Inc. business.", []string{"SunPro"}},
		{"ExpSunCopyright", "Copyright (C) 2004 by Sun Microsystems, Inc. All rights reserved.", []string{"SunPro"}},
		{"Cephes", "Cephes Math Library Release 2.8: June, 2000", []string{"LicenseRef-Cephes"}},
		{"GoBSDDoesNotOverride", "The Go Authors BSD-style license. Cephes Math Library. Copyright Sun Microsystems", []string{"SunPro", "LicenseRef-Cephes"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := sourceNotices(tc.comments); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("sourceNotices = %v, want %v", got, tc.want)
			}
		})
	}
}
