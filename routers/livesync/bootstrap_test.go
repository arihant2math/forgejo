// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bytes"
	"io"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/gzip"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNegotiateEncoding(t *testing.T) {
	for header, want := range map[string]string{
		"":                           "",
		"identity":                   "",
		"gzip":                       "gzip",
		"gzip, deflate, br, zstd":    "br",
		"br;q=0, gzip;q=0.5":         "gzip",
		"BR":                         "br",
		"gzip;q=0":                   "",
		" br ; q=0.1 , gzip":         "br",
		"deflate, *":                 "",
		"gzip;q=1.0, br;q=0.0, zstd": "gzip",
	} {
		assert.Equal(t, want, negotiateEncoding(header), "%q", header)
	}
}

// TestCompress checks that every encoding streams: what was flushed can be
// decoded before the stream is closed, and the closed stream decodes whole.
func TestCompress(t *testing.T) {
	decoders := map[string]func(io.Reader) (io.Reader, error){
		"":     func(r io.Reader) (io.Reader, error) { return r, nil },
		"br":   func(r io.Reader) (io.Reader, error) { return brotli.NewReader(r), nil },
		"gzip": func(r io.Reader) (io.Reader, error) { return gzip.NewReader(r) },
	}
	for enc, decode := range decoders {
		t.Run(enc, func(t *testing.T) {
			var buf bytes.Buffer
			out, closeOut := compress(&buf, enc)
			first := strings.Repeat(`{"v":1,"g":"repo:1"}`+"\n", 100)
			_, err := out.Write([]byte(first))
			require.NoError(t, err)
			require.NoError(t, out.Flush())
			r, err := decode(bytes.NewReader(bytes.Clone(buf.Bytes())))
			require.NoError(t, err)
			got := make([]byte, len(first))
			_, err = io.ReadFull(r, got)
			require.NoError(t, err, "flushed data is decodable before the end")
			assert.Equal(t, first, string(got))

			_, err = out.Write([]byte("end\n"))
			require.NoError(t, err)
			require.NoError(t, closeOut())
			r, err = decode(&buf)
			require.NoError(t, err)
			all, err := io.ReadAll(r)
			require.NoError(t, err)
			assert.Equal(t, first+"end\n", string(all))
		})
	}
}
