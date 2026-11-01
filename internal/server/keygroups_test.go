package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/murongg/SubLane/internal/apikey"
	"github.com/murongg/SubLane/internal/groups"
)

func TestPersonalKeyGroupEndpointAndWebsocketRecheck(t *testing.T) {
	f := newForwardFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("unexpected inference") })
	ctx := context.Background()
	target, err := f.groups.Save(ctx, 0, groups.Input{Name: "Synthetic destination", Enabled: true, AccountIDs: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	h := New(Options{Auth: f.identity, Keys: f.keys, Groups: f.groups})
	origin := "http://example.test"
	member := request(h, "POST", "/api/auth/login", origin, map[string]string{"username": "member-test", "password": "member pass 42"}, nil).Result().Cookies()[0]
	owner := request(h, "POST", "/api/auth/login", origin, map[string]string{"username": "owner-test", "password": "owner pass 42"}, nil).Result().Cookies()[0]
	path := fmt.Sprintf("/api/keys/%d/group", f.keyID)
	input := map[string]int64{"group_id": target.ID}
	for _, check := range []struct {
		cookie *http.Cookie
		origin string
		want   int
	}{
		{nil, origin, 401}, {owner, origin, 404}, {member, "https://other.example.test", 403}, {member, origin, 403},
	} {
		if result := request(h, "PUT", path, check.origin, input, check.cookie); result.Code != check.want {
			t.Fatalf("boundary: want %d got %d %s", check.want, result.Code, result.Body.String())
		}
	}
	if err := f.groups.SetMemberGroups(ctx, f.userID, []int64{1, target.ID}); err != nil {
		t.Fatal(err)
	}
	if result := request(h, "PUT", path, origin, map[string]int64{"group_id": 0}, member); result.Code != 400 {
		t.Fatal("invalid target", result.Code)
	}
	conn, _, err := websocket.DefaultDialer.Dial(strings.Replace(f.server.URL, "http://", "ws://", 1)+"/v1/responses", http.Header{"Authorization": {"Bearer " + f.secret}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(map[string]any{"type": "response.create", "model": "synthetic-model", "input": []any{}, "generate": false}); err != nil {
		t.Fatal(err)
	}
	for {
		var event map[string]any
		if err := conn.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event["type"] == "error" {
			t.Fatal(event)
		}
		if event["type"] == "response.completed" {
			break
		}
	}
	result := request(h, "PUT", path, origin, input, member)
	var key apikey.Key
	if result.Code != 200 || json.Unmarshal(result.Body.Bytes(), &key) != nil || key.GroupID != target.ID || strings.Contains(result.Body.String(), f.secret) {
		t.Fatal("group response", result.Code, result.Body.String())
	}
	if err := conn.WriteJSON(map[string]any{"type": "response.create", "model": "synthetic-model", "input": []any{}, "generate": false}); err != nil {
		t.Fatal(err)
	}
	var event struct {
		Type  string `json:"type"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := conn.ReadJSON(&event); err != nil || event.Type != "error" || event.Error.Code != "invalid_api_key" {
		t.Fatal("stale WebSocket group accepted", event, err)
	}
	principal, err := f.keys.Authenticate(ctx, f.secret)
	if err != nil || principal.GroupID != target.ID {
		t.Fatal("new authentication did not use destination", err)
	}
}
