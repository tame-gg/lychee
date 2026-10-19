package control

import (
	"encoding/json"
	"os"
	"regexp"
)

var (
	clientRe        = regexp.MustCompile(`^[A-Za-z0-9._-]{1,32}$`)
	clientVersionRe = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,32}$`)
)

type helloRequest struct {
	Protocol []int
	Client   string
	Version  string
}

func parseHello(raw json.RawMessage) (*helloRequest, *apiError) {
	m, aerr := argsObject(raw)
	if aerr != nil {
		return nil, aerr
	}
	for k := range m {
		switch k {
		case "protocol", "client", "client_version":
		default:
			return nil, &apiError{code: errUnknownField, message: "unknown field args." + k, data: map[string]any{"field": "args." + k}}
		}
	}
	h := &helloRequest{}
	protoRaw, ok := m["protocol"]
	if !ok {
		return nil, bad("protocol is required")
	}
	if err := json.Unmarshal(protoRaw, &h.Protocol); err != nil {
		return nil, bad("protocol must be an array of integers")
	}
	if len(h.Protocol) < 1 || len(h.Protocol) > 8 {
		return nil, bad("protocol must have 1 to 8 entries")
	}
	seen := map[int]bool{}
	for _, p := range h.Protocol {
		if p < 1 || p > 1000 {
			return nil, bad("protocol entries must be between 1 and 1000")
		}
		if seen[p] {
			return nil, bad("protocol entries must be unique")
		}
		seen[p] = true
	}
	clientRaw, ok := m["client"]
	if !ok {
		return nil, bad("client is required")
	}
	if err := json.Unmarshal(clientRaw, &h.Client); err != nil || !clientRe.MatchString(h.Client) {
		return nil, bad("client must match ^[A-Za-z0-9._-]{1,32}$")
	}
	versionRaw, ok := m["client_version"]
	if !ok {
		return nil, bad("client_version is required")
	}
	if err := json.Unmarshal(versionRaw, &h.Version); err != nil || !clientVersionRe.MatchString(h.Version) {
		return nil, bad("client_version must match ^[A-Za-z0-9._+-]{1,32}$")
	}
	return h, nil
}

func negotiate(client []int) (int, *apiError) {
	best := 0
	for _, p := range client {
		if p == ProtocolVersion && p > best {
			best = p
		}
	}
	if best == 0 {
		return 0, &apiError{code: errVersionUnsupported, message: "no common protocol version", closes: true, data: map[string]any{"supported": []int{ProtocolVersion}}}
	}
	return best, nil
}

type authView struct {
	Model         string  `json:"model"`
	Privilege     string  `json:"privilege"`
	AuthorizedUID *int    `json:"authorized_uid,omitempty"`
	AuthorizedSID *string `json:"authorized_sid,omitempty"`
}

type intervalView struct {
	Min     int64 `json:"min"`
	Max     int64 `json:"max"`
	Default int64 `json:"default"`
}

type weightRangeView struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

type limitsView struct {
	MaxFrame         int             `json:"max_frame"`
	MaxInFlight      int             `json:"max_in_flight"`
	HelloTimeoutMs   int64           `json:"hello_timeout_ms"`
	GraceMs          int64           `json:"grace_ms"`
	StartupTimeoutMs int64           `json:"startup_timeout_ms"`
	StatsIntervalMs  intervalView    `json:"stats_interval_ms"`
	Weight           weightRangeView `json:"weight"`
}

type helloResultView struct {
	Protocol      int         `json:"protocol"`
	HelperVersion string      `json:"helper_version"`
	OS            string      `json:"os"`
	Arch          string      `json:"arch"`
	PID           int         `json:"pid"`
	Instance      string      `json:"instance"`
	Session       int         `json:"session"`
	Auth          authView    `json:"auth"`
	Capabilities  []string    `json:"capabilities"`
	Limits        limitsView  `json:"limits"`
	Capture       captureView `json:"capture"`
}

func (s *Server) buildHelloResult(proto int, peer PeerInfo) helloResultView {
	version := s.cfg.Version
	if version == "" {
		version = "dev"
	}
	auth := authView{Model: s.cfg.Auth.Model, Privilege: s.cfg.Auth.Privilege}
	if s.cfg.Auth.UID != nil {
		auth.AuthorizedUID = s.cfg.Auth.UID
	}
	if s.cfg.Auth.SID != nil {
		auth.AuthorizedSID = s.cfg.Auth.SID
	}
	return helloResultView{
		Protocol:      proto,
		HelperVersion: version,
		OS:            s.cfg.GOOS,
		Arch:          s.cfg.GOARCH,
		PID:           os.Getpid(),
		Instance:      s.instance,
		Session:       s.sessionNum,
		Auth:          auth,
		Capabilities:  s.cfg.Capabilities,
		Limits: limitsView{
			MaxFrame:         MaxFrame,
			MaxInFlight:      MaxInFlight,
			HelloTimeoutMs:   msInt(HelloTimeout),
			GraceMs:          msInt(GracePeriod),
			StartupTimeoutMs: msInt(StartupTimeout),
			StatsIntervalMs:  intervalView{Min: msInt(StatsIntervalMin), Max: msInt(StatsIntervalMax), Default: msInt(StatsIntervalDef)},
			Weight:           weightRangeView{Min: WeightMin, Max: WeightMax},
		},
		Capture: s.captureView(),
	}
}

func (s *Server) captureView() captureView {
	cv := captureView{Available: s.cfg.Capture.Available}
	if s.cfg.Capture.Error != "" {
		e := s.cfg.Capture.Error
		cv.Error = &e
	}
	return cv
}
