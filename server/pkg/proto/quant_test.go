package proto

import (
	"math"
	"testing"
)

// Same expectations as contracts/ts/test/quant.test.ts.
func TestQuant(t *testing.T) {
	if MetersToCm(1234.567) != 123457 {
		t.Fatal("MetersToCm")
	}
	if YawToU8(0) != 0 || YawToU8(math.Pi) != 128 || YawToU8(-math.Pi/2) != 192 {
		t.Fatal("YawToU8")
	}
	if math.Abs(U16ToYaw(YawToU16(1.2345))-1.2345) > 1e-4 {
		t.Fatal("YawToU16")
	}
	if PitchToU8(10) != 255 {
		t.Fatal("PitchToU8")
	}
	if VelToCms(1000) != 32767 || VelToCms(-8.004) != -800 || VelToCms(-0.005) != 0 {
		t.Fatalf("VelToCms %d %d", VelToCms(-8.004), VelToCms(-0.005))
	}
}
