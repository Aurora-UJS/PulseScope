package main

import "testing"

func TestPushHistoryAlignsLateAndMissingSignals(t *testing.T) {
	o := NewObsShm()
	o.pushHistory(1, map[string]float64{"yaw": 1})
	o.pushHistory(2, map[string]float64{"pitch": 2})

	got := o.seriesJSON(10)
	if len(got["time"].([]float64)) != 2 {
		t.Fatalf("time length = %d, want 2", len(got["time"].([]float64)))
	}
	yaw := got["yaw"].([]*float64)
	pitch := got["pitch"].([]*float64)
	if yaw[0] == nil || *yaw[0] != 1 || yaw[1] != nil {
		t.Fatalf("yaw series is not aligned: %#v", yaw)
	}
	if pitch[0] != nil || pitch[1] == nil || *pitch[1] != 2 {
		t.Fatalf("pitch series is not aligned: %#v", pitch)
	}
}

func TestPushHistoryIgnoresDuplicateFrame(t *testing.T) {
	o := NewObsShm()
	o.pushHistory(7, map[string]float64{"yaw": 1})
	o.pushHistory(7, map[string]float64{"yaw": 9})

	got := o.seriesJSON(10)
	if len(got["time"].([]float64)) != 1 {
		t.Fatalf("duplicate frame produced %d samples, want 1", len(got["time"].([]float64)))
	}
	yaw := got["yaw"].([]*float64)
	if yaw[0] == nil || *yaw[0] != 1 {
		t.Fatalf("duplicate frame overwrote the sample: %#v", yaw)
	}
}
