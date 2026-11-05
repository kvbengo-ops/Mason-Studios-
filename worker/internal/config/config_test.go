package config

import (
	"strings"
	"testing"
	"time"
)

// This file used to carry ~15 tests under the banner "TestLoad_Kie*" pinning
// the fal-era dual-vendor routing seam: KIE_ENABLED as an opt-in second
// vendor (TestLoad_KieDefaultsOff, TestLoad_KieEnabled_WithAPIKey,
// TestLoad_KieEnabledWordyTrue_ParsesOffNoAPIKeyError, ...) and KIE_MODELS
// as a comma-separated allowlist resolving fal.Descriptor.ID values to fal
// endpoints kie could route (TestLoad_KieModels_Valid_ResolvesToEndpoint,
// TestLoad_KieModels_UnroutableModel_FailsStartup,
// TestLoad_KieModels_Kling_Routes, TestLoad_KieModels_Seedance20Tiers_FailStartup,
// and half a dozen more). Once fal was decommissioned and kie became the
// only vendor, there was nothing left to route AWAY from: KieEnabled and
// KieModelEndpoints/parseKieModels were deleted from config.go outright
// (see that file's own header comments), not merely defaulted differently,
// so every test in that banner tested a code path that no longer exists.
//
// What replaces them: KIE_API_KEY moved from "required only once
// KIE_ENABLED=1" to unconditionally required, the same bar FAL_KEY used to
// hold — see TestLoad_MissingRequiredVar below, which now covers it the
// same way it covers DATABASE_URL. KIE_WEBHOOK_SECRET stays optional (kie's
// webhook signing is opt-in on THEIR side, independent of how many vendors
// this worker speaks to) and its warning-on-empty behavior, unconditional
// now rather than gated on KieEnabled, is pinned below by
// TestLoad_KieWebhookSecretUnset_Warns and its neighbors.

func fullEnv() map[string]string {
	return map[string]string{
		"DATABASE_URL":              "postgres://localhost/ugc",
		"SUPABASE_URL":              "https://example.supabase.co",
		"SUPABASE_SERVICE_ROLE_KEY": "service-role-key",
		"KIE_API_KEY":               "kie-key",
		"KIE_WEBHOOK_SECRET":        "kie-webhook-secret",
		"APP_BASE_URL":              "https://worker.example.com",
	}
}

func TestLoad_AllRequiredPresent_Defaults(t *testing.T) {
	cfg, err := load(fullEnv())
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if cfg.RenderConcurrency != 10 {
		t.Errorf("RenderConcurrency default = %d, want 10", cfg.RenderConcurrency)
	}
	if cfg.FFmpegConcurrency != 2 {
		t.Errorf("FFmpegConcurrency default = %d, want 2", cfg.FFmpegConcurrency)
	}
	if cfg.Port != 8080 {
		t.Errorf("Port default = %d, want 8080", cfg.Port)
	}
	if cfg.Mode != "development" {
		t.Errorf("Mode default = %q, want %q", cfg.Mode, "development")
	}
	if !cfg.IsDev() {
		t.Errorf("IsDev() = false, want true when MODE is unset")
	}
	if cfg.AudioEnabled {
		t.Errorf("AudioEnabled default = true, want false (audio off by default during testing)")
	}
	if cfg.ReconcileGiveUpAfter != 30*time.Minute {
		t.Errorf("ReconcileGiveUpAfter default = %v, want %v", cfg.ReconcileGiveUpAfter, 30*time.Minute)
	}
	if len(cfg.Warnings) != 0 {
		t.Errorf("Warnings = %v, want none (fullEnv sets KIE_WEBHOOK_SECRET)", cfg.Warnings)
	}
}

func TestLoad_Mode_Production(t *testing.T) {
	env := fullEnv()
	env["MODE"] = "production"
	cfg, err := load(env)
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if cfg.Mode != "production" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "production")
	}
	if cfg.IsDev() {
		t.Errorf("IsDev() = true, want false when MODE=production")
	}
}

// The unsafe direction is landing on "production" by accident; the safe one
// is staying mocked. Garbage must fall the safe way — see config.go's
// parseMode doc comment.
func TestLoad_Mode_GarbageFallsBackToDevelopment(t *testing.T) {
	for _, junk := range []string{"Production", "PRODUCTION", "prod", "1", ""} {
		env := fullEnv()
		env["MODE"] = junk
		cfg, err := load(env)
		if err != nil {
			t.Fatalf("load() unexpected error for MODE=%q: %v", junk, err)
		}
		if cfg.Mode != "development" {
			t.Errorf("Mode for MODE=%q = %q, want %q", junk, cfg.Mode, "development")
		}
	}
}

func TestLoad_AudioEnabled(t *testing.T) {
	env := fullEnv()
	env["AUDIO_ENABLED"] = "1"
	cfg, err := load(env)
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if !cfg.AudioEnabled {
		t.Errorf("AudioEnabled = false, want true")
	}
}

func TestLoad_Overrides(t *testing.T) {
	env := fullEnv()
	env["RENDER_CONCURRENCY"] = "25"
	env["FFMPEG_CONCURRENCY"] = "4"
	env["PORT"] = "9090"
	cfg, err := load(env)
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if cfg.RenderConcurrency != 25 {
		t.Errorf("RenderConcurrency = %d, want 25", cfg.RenderConcurrency)
	}
	if cfg.FFmpegConcurrency != 4 {
		t.Errorf("FFmpegConcurrency = %d, want 4", cfg.FFmpegConcurrency)
	}
	if cfg.Port != 9090 {
		t.Errorf("Port = %d, want 9090", cfg.Port)
	}
}

// KIE_API_KEY joins the required list here — see this file's own header
// comment for why that's a promotion from "required only once KIE_ENABLED=1
// was set" rather than a brand new requirement.
//
// MODE=production is set explicitly for every case, and for KIE_API_KEY it is
// load-bearing rather than tidiness: that variable is required in production
// and OPTIONAL in development, so a test that left MODE unset would be
// asserting the development rule while claiming to test the production one.
// TestLoad_KieKeyOptionalInDevelopment below covers the other half.
func TestLoad_MissingRequiredVar(t *testing.T) {
	tests := []string{
		"DATABASE_URL",
		"SUPABASE_URL",
		"SUPABASE_SERVICE_ROLE_KEY",
		"KIE_API_KEY",
		"APP_BASE_URL",
	}
	for _, name := range tests {
		t.Run(name, func(t *testing.T) {
			env := fullEnv()
			env["MODE"] = "production"
			delete(env, name)
			_, err := load(env)
			if err == nil {
				t.Fatalf("load() expected error for missing %s, got nil", name)
			}
			if !strings.Contains(err.Error(), name) {
				t.Errorf("load() error = %q, want it to name %s", err.Error(), name)
			}
		})
	}
}

func TestLoad_MissingMultipleRequiredVars_ReportsAll(t *testing.T) {
	// MODE=production for the same reason the test above sets it: in
	// development KIE_API_KEY is not required and would not be reported.
	env := map[string]string{"MODE": "production"}
	_, err := load(env)
	if err == nil {
		t.Fatalf("load() expected error, got nil")
	}
	for _, name := range []string{"DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "KIE_API_KEY", "APP_BASE_URL"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("load() error missing mention of %s; error = %q", name, err.Error())
		}
	}
}

func TestLoad_ReconcileGiveUpAfter_Override(t *testing.T) {
	env := fullEnv()
	env["RECONCILE_GIVE_UP_AFTER_MINUTES"] = "5"
	cfg, err := load(env)
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if cfg.ReconcileGiveUpAfter != 5*time.Minute {
		t.Errorf("ReconcileGiveUpAfter = %v, want %v", cfg.ReconcileGiveUpAfter, 5*time.Minute)
	}
}

func TestLoad_ReconcileGiveUpAfter_Invalid(t *testing.T) {
	env := fullEnv()
	env["RECONCILE_GIVE_UP_AFTER_MINUTES"] = "not-a-number"
	_, err := load(env)
	if err == nil {
		t.Fatalf("load() expected error for invalid RECONCILE_GIVE_UP_AFTER_MINUTES, got nil")
	}
	if !strings.Contains(err.Error(), "RECONCILE_GIVE_UP_AFTER_MINUTES") {
		t.Errorf("load() error = %q, want it to name RECONCILE_GIVE_UP_AFTER_MINUTES", err.Error())
	}
}

func TestLoad_InvalidIntVar(t *testing.T) {
	env := fullEnv()
	env["RENDER_CONCURRENCY"] = "not-a-number"
	_, err := load(env)
	if err == nil {
		t.Fatalf("load() expected error for invalid RENDER_CONCURRENCY, got nil")
	}
	if !strings.Contains(err.Error(), "RENDER_CONCURRENCY") {
		t.Errorf("load() error = %q, want it to name RENDER_CONCURRENCY", err.Error())
	}
}

// TestLoad_KieAPIKeyDefault pins that KieAPIKey/KieWebhookSecret round-trip
// the values fullEnv() sets — the positive counterpart to
// TestLoad_MissingRequiredVar's KIE_API_KEY case above.
func TestLoad_KieAPIKeyDefault(t *testing.T) {
	cfg, err := load(fullEnv())
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if cfg.KieAPIKey != "kie-key" {
		t.Errorf("KieAPIKey = %q, want %q", cfg.KieAPIKey, "kie-key")
	}
	if cfg.KieWebhookSecret != "kie-webhook-secret" {
		t.Errorf("KieWebhookSecret = %q, want %q", cfg.KieWebhookSecret, "kie-webhook-secret")
	}
}

// The failure this exists to stop being silent: no KIE_WEBHOOK_SECRET boots
// fine, renders fine, and is 45-90 seconds late on every completion, because
// /webhooks/kie rejects the callback and only the reconcile poll notices. It
// ran that way for six days back when this was gated on KIE_ENABLED=1; the
// gate is gone (kie is unconditionally the vendor now) but the warning is
// not.
func TestLoad_KieWebhookSecretUnset_Warns(t *testing.T) {
	env := fullEnv()
	delete(env, "KIE_WEBHOOK_SECRET")

	cfg, err := load(env)
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if len(cfg.Warnings) != 1 {
		t.Fatalf("Warnings = %v, want exactly one", cfg.Warnings)
	}
	// The consequence, not just the variable name: an operator reading
	// "KIE_WEBHOOK_SECRET is unset" learns nothing about what it costs.
	for _, want := range []string{"KIE_WEBHOOK_SECRET", "reconcile poll", "45-90s"} {
		if !strings.Contains(cfg.Warnings[0], want) {
			t.Errorf("warning %q does not mention %q", cfg.Warnings[0], want)
		}
	}
}

func TestLoad_KieWebhookSecretSet_NoWarning(t *testing.T) {
	cfg, err := load(fullEnv())
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if len(cfg.Warnings) != 0 {
		t.Errorf("Warnings = %v, want none", cfg.Warnings)
	}
}

// ASSEMBLE_ENABLED=true reads as "on" to a human but the parser only ever
// treats exactly "1" as on — everything else is off, silently. This is the
// trap worker/.env ships one edit away from (ASSEMBLE_ENABLED=false today).
func TestLoad_WordyBooleanTrue_WarnsAndStaysOff(t *testing.T) {
	env := fullEnv()
	env["ASSEMBLE_ENABLED"] = "true"

	cfg, err := load(env)
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if cfg.AssembleEnabled {
		t.Errorf("AssembleEnabled = true, want false: only \"1\" turns it on")
	}
	if len(cfg.Warnings) != 1 {
		t.Fatalf("Warnings = %v, want exactly one", cfg.Warnings)
	}
	for _, want := range []string{"ASSEMBLE_ENABLED", "\"1\""} {
		if !strings.Contains(cfg.Warnings[0], want) {
			t.Errorf("warning %q does not mention %q", cfg.Warnings[0], want)
		}
	}
}

// Same trap, a different flag in the list, to confirm it isn't
// ASSEMBLE_ENABLED-specific.
func TestLoad_AudioEnabledWordyTrue_WarnsAndStaysOff(t *testing.T) {
	env := fullEnv()
	env["AUDIO_ENABLED"] = "true"

	cfg, err := load(env)
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if cfg.AudioEnabled {
		t.Errorf("AudioEnabled = true, want false: only \"1\" turns it on")
	}
	if len(cfg.Warnings) != 1 {
		t.Fatalf("Warnings = %v, want exactly one", cfg.Warnings)
	}
	if !strings.Contains(cfg.Warnings[0], "AUDIO_ENABLED") {
		t.Errorf("warning %q does not mention AUDIO_ENABLED", cfg.Warnings[0])
	}
}

// Case-insensitivity: "TRUE" and "Yes" trip the same warning as "true".
func TestLoad_WordyBoolean_CaseInsensitive(t *testing.T) {
	cases := []string{"TRUE", "Yes"}
	for _, val := range cases {
		env := fullEnv()
		env["ASSEMBLE_ENABLED"] = val

		cfg, err := load(env)
		if err != nil {
			t.Fatalf("load() unexpected error for ASSEMBLE_ENABLED=%q: %v", val, err)
		}
		if cfg.AssembleEnabled {
			t.Errorf("AssembleEnabled = true for %q, want false", val)
		}
		if len(cfg.Warnings) != 1 {
			t.Fatalf("Warnings = %v for %q, want exactly one", cfg.Warnings, val)
		}
		if !strings.Contains(cfg.Warnings[0], "ASSEMBLE_ENABLED") {
			t.Errorf("warning %q does not mention ASSEMBLE_ENABLED", cfg.Warnings[0])
		}
	}
}

// "1", "0", "false" and unset are all unambiguous about intent and must
// stay silent — only the wordy forms ("true"/"yes"/"on"/"enabled") warn.
func TestLoad_LegitimateBooleanValues_NoWarning(t *testing.T) {
	cases := []string{"1", "0", "false"}
	for _, val := range cases {
		env := fullEnv()
		env["ASSEMBLE_ENABLED"] = val

		cfg, err := load(env)
		if err != nil {
			t.Fatalf("load() unexpected error for ASSEMBLE_ENABLED=%q: %v", val, err)
		}
		if len(cfg.Warnings) != 0 {
			t.Errorf("Warnings = %v for ASSEMBLE_ENABLED=%q, want none", cfg.Warnings, val)
		}
	}

	// Unset entirely.
	cfg, err := load(fullEnv())
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if len(cfg.Warnings) != 0 {
		t.Errorf("Warnings = %v for unset ASSEMBLE_ENABLED, want none", cfg.Warnings)
	}
}

// The KIE_WEBHOOK_SECRET warning and a wordy-boolean warning must coexist
// without one clobbering the other.
func TestLoad_WordyBooleanWarning_CoexistsWithKieWebhookWarning(t *testing.T) {
	env := fullEnv()
	delete(env, "KIE_WEBHOOK_SECRET") // -> triggers that warning.
	env["ASSEMBLE_ENABLED"] = "true"  // -> triggers the wordy-boolean warning too.

	cfg, err := load(env)
	if err != nil {
		t.Fatalf("load() unexpected error: %v", err)
	}
	if len(cfg.Warnings) != 2 {
		t.Fatalf("Warnings = %v, want exactly two", cfg.Warnings)
	}

	var sawWebhook, sawAssemble bool
	for _, w := range cfg.Warnings {
		if strings.Contains(w, "KIE_WEBHOOK_SECRET") {
			sawWebhook = true
		}
		if strings.Contains(w, "ASSEMBLE_ENABLED") {
			sawAssemble = true
		}
	}
	if !sawWebhook {
		t.Errorf("Warnings = %v, missing KIE_WEBHOOK_SECRET warning", cfg.Warnings)
	}
	if !sawAssemble {
		t.Errorf("Warnings = %v, missing ASSEMBLE_ENABLED warning", cfg.Warnings)
	}
}

// The other half of the asymmetry, and the half with a safety argument behind
// it.
//
// A development worker never reaches kie — the render is mocked before any
// client is constructed — so demanding the key makes nothing safer. What it
// does is refuse to boot until somebody pastes a REAL production key into a
// local config, which is how a live credential ends up in a file whose whole
// purpose is that it touches nothing. This project has already lost money
// twice to a local run that turned out not to be local; making the safe
// configuration the one that starts is part of not doing it a third time.
//
// Found by running the worker, not by reading it: with MODE=development and
// every other variable set, it exited with "required environment variable
// KIE_API_KEY is not set".
func TestLoad_KieKeyOptionalInDevelopment(t *testing.T) {
	env := fullEnv()
	env["MODE"] = "development"
	delete(env, "KIE_API_KEY")

	cfg, err := load(env)
	if err != nil {
		t.Fatalf("load() in development without KIE_API_KEY: %v — a dev worker never calls kie, so requiring the key only pushes a real one into a local config", err)
	}
	if cfg.KieAPIKey != "" {
		t.Errorf("KieAPIKey = %q, want empty", cfg.KieAPIKey)
	}
	if !cfg.IsDev() {
		t.Error("IsDev() = false for MODE=development")
	}
}

func TestLoad_NumericVarsMustBePositive(t *testing.T) {
	for _, name := range []string{
		"RENDER_CONCURRENCY",
		"FFMPEG_CONCURRENCY",
		"PORT",
		"RECONCILE_GIVE_UP_AFTER_MINUTES",
	} {
		for _, value := range []string{"0", "-1"} {
			t.Run(name+"="+value, func(t *testing.T) {
				env := fullEnv()
				env[name] = value
				_, err := load(env)
				if err == nil {
					t.Fatalf("load() expected error for %s=%s, got nil", name, value)
				}
				if !strings.Contains(err.Error(), name) {
					t.Errorf("load() error = %q, want it to name %s", err.Error(), name)
				}
			})
		}
	}
}

func TestLoad_PortMustFitTCPRange(t *testing.T) {
	env := fullEnv()
	env["PORT"] = "65536"
	_, err := load(env)
	if err == nil {
		t.Fatal("load() expected error for PORT=65536, got nil")
	}
	if !strings.Contains(err.Error(), "PORT") {
		t.Errorf("load() error = %q, want it to name PORT", err.Error())
	}
}
