package main

import (
	"strings"
	"testing"

	"lodestone/server/pkg/svc"
)

func TestProductionRefusesDevAuth(t *testing.T) {
	t.Setenv("LODESTONE_ENV", "production")
	t.Setenv("LODESTONE_DEV_AUTH", "1")
	err := run(svc.New("account-test", ":0"))
	if err == nil || !strings.Contains(err.Error(), "LODESTONE_DEV_AUTH") {
		t.Fatal("dev auth must be refused in production:", err)
	}
}

func TestProductionRefusesDevKeys(t *testing.T) {
	t.Setenv("LODESTONE_ENV", "production")
	t.Setenv("LODESTONE_DEV_AUTH", "")
	t.Setenv("LODESTONE_SESSION_PRIVATE_KEY", "")
	err := run(svc.New("account-test", ":0"))
	if err == nil || !strings.Contains(err.Error(), "must be set in production") {
		t.Fatal("dev keys must be refused in production:", err)
	}
}

func TestProviders(t *testing.T) {
	p := providers(" google.com, github.com ,")
	if len(p) != 2 || p["google.com"] != "google" || p["github.com"] != "github" {
		t.Fatal(p)
	}
}
