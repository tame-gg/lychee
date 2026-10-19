package control

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

const (
	errBadRequest          = "bad_request"
	errFrameTooLarge       = "frame_too_large"
	errTooManyRequests     = "too_many_requests"
	errUnknownCommand      = "unknown_command"
	errUnknownField        = "unknown_field"
	errHelloRequired       = "hello_required"
	errVersionUnsupported  = "version_unsupported"
	errBusy                = "busy"
	errInvalidState        = "invalid_state"
	errUnknownAdapterCode  = "unknown_adapter"
	errOutOfRange          = "out_of_range"
	errNoAdapters          = "no_adapters"
	errUnsupportedPlatform = "unsupported_platform"
	errPermissionDenied    = "permission_denied"
	errInternal            = "internal"
)

type apiError struct {
	code    string
	message string
	data    map[string]any
	closes  bool
	id      *int64
}

func (e *apiError) Error() string { return e.code + ": " + e.message }

func bad(message string) *apiError { return &apiError{code: errBadRequest, message: message} }

func badClose(message string) *apiError {
	return &apiError{code: errBadRequest, message: message, closes: true}
}

type errBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data,omitempty"`
}

type response struct {
	ID     *int64          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *errBody        `json:"error,omitempty"`
}

func okResponse(id *int64, result any) ([]byte, error) {
	raw, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	return json.Marshal(response{ID: id, OK: true, Result: raw})
}

func errResponse(id *int64, e *apiError) []byte {
	b, _ := json.Marshal(response{ID: id, OK: false, Error: &errBody{Code: e.code, Message: e.message, Data: e.data}})
	return b
}

type eventFrame struct {
	Event string          `json:"event"`
	Seq   uint64          `json:"seq"`
	Data  json.RawMessage `json:"data"`
}

func encodeEvent(name string, seq uint64, data any) []byte {
	raw, _ := json.Marshal(data)
	b, _ := json.Marshal(eventFrame{Event: name, Seq: seq, Data: raw})
	return b
}

type frameReader struct {
	r   *bufio.Reader
	max int
}

func newFrameReader(r io.Reader) *frameReader {
	return &frameReader{r: bufio.NewReaderSize(r, 4096), max: MaxFrame}
}

var errLineTooLong = errors.New("frame too large")

func (fr *frameReader) read() ([]byte, error) {
	var buf []byte
	for {
		b, err := fr.r.ReadByte()
		if err != nil {
			if err == io.EOF && len(buf) > 0 {
				return nil, io.ErrUnexpectedEOF
			}
			return nil, err
		}
		if b == '\n' {
			return buf, nil
		}
		if len(buf) >= fr.max-1 {
			return nil, errLineTooLong
		}
		buf = append(buf, b)
	}
}

type request struct {
	id   *int64
	cmd  string
	args json.RawMessage
}

func decodeEnvelope(line []byte) (*request, *apiError) {
	if !utf8.Valid(line) {
		return nil, badClose("frame is not valid UTF-8")
	}
	if bytes.IndexByte(line, 0) >= 0 {
		return nil, badClose("frame contains a NUL byte")
	}
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.UseNumber()
	var top map[string]json.RawMessage
	if err := dec.Decode(&top); err != nil {
		return nil, badClose("frame is not a JSON object")
	}
	if dec.More() {
		return nil, badClose("frame has trailing data after the JSON object")
	}
	idRaw, ok := top["id"]
	if !ok {
		return nil, badClose("missing id")
	}
	var idNum json.Number
	if err := json.Unmarshal(idRaw, &idNum); err != nil {
		return nil, badClose("id must be an integer")
	}
	if bytes.ContainsAny([]byte(idNum), ".eE") {
		return nil, badClose("id must be an integer")
	}
	id, err := idNum.Int64()
	if err != nil || id < 1 || id > (1<<53-1) {
		return nil, badClose("id must be an integer between 1 and 2^53-1")
	}
	for k := range top {
		switch k {
		case "id", "cmd", "args":
		default:
			return nil, &apiError{code: errUnknownField, message: "unknown field " + k, data: map[string]any{"field": k}, id: &id}
		}
	}
	cmdRaw, ok := top["cmd"]
	if !ok {
		return nil, &apiError{code: errBadRequest, message: "missing cmd", closes: true, id: &id}
	}
	var cmd string
	if err := json.Unmarshal(cmdRaw, &cmd); err != nil {
		return nil, &apiError{code: errBadRequest, message: "cmd must be a string", closes: true, id: &id}
	}
	req := &request{id: &id, cmd: cmd}
	if argsRaw, ok := top["args"]; ok {
		trimmed := bytes.TrimSpace(argsRaw)
		if len(trimmed) == 0 || trimmed[0] != '{' {
			return nil, &apiError{code: errBadRequest, message: "args must be an object", data: map[string]any{"field": "args"}, id: &id}
		}
		req.args = argsRaw
	}
	return req, nil
}
