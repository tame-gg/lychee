package control

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

func sprintfLine(format string, args ...any) string {
	s := fmt.Sprintf(format, args...)
	return strings.TrimRight(s, "\n")
}

func sanitizeLog(msg string) string {
	var b strings.Builder
	for _, r := range msg {
		if r == '\t' || (r >= 0x20 && r != 0x7f) {
			b.WriteRune(r)
		} else {
			b.WriteRune(' ')
		}
	}
	out := b.String()
	if len(out) > 1024 {
		out = out[:1024]
		for !utf8.ValidString(out) && len(out) > 0 {
			out = out[:len(out)-1]
		}
	}
	return out
}

func argsObject(raw json.RawMessage) (map[string]json.RawMessage, *apiError) {
	if len(raw) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, bad("args must be an object")
	}
	return m, nil
}

func validAdapterName(s string) bool {
	if len(s) < 1 || len(s) > MaxStringLen || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}
