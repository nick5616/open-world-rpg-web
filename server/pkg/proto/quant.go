package proto

import "math"

// Quantization helpers shared by the zone server and bots. Mirrors
// contracts/ts/src/quant.ts; both are covered by quant tests with the same
// expected values. Not codecs: they convert units before encoding.

// MetersToCm rounds meters to int32 centimeters (positions on the wire).
func MetersToCm(m float64) int32 {
	v := jsRound(m * 100)
	if v > math.MaxInt32 {
		return math.MaxInt32
	}
	if v < math.MinInt32 {
		return math.MinInt32
	}
	return int32(v)
}

// CmToMeters is the inverse of MetersToCm.
func CmToMeters(c int32) float64 { return float64(c) / 100 }

// VelToCms clamps m/s to int16 cm/s (+/-327 m/s, far above any legit speed).
func VelToCms(v float64) int16 {
	c := jsRound(v * 100)
	if c > math.MaxInt16 {
		return math.MaxInt16
	}
	if c < math.MinInt16 {
		return math.MinInt16
	}
	return int16(c)
}

// CmsToVel is the inverse of VelToCms.
func CmsToVel(c int16) float64 { return float64(c) / 100 }

func wrapAngle(rad float64) float64 {
	t := math.Mod(rad, 2*math.Pi)
	if t < 0 {
		t += 2 * math.Pi
	}
	return t
}

// YawToU8 maps radians to one byte (others' facing: 1.4 degree steps are plenty).
func YawToU8(rad float64) uint8 { return uint8(int(jsRound(wrapAngle(rad)/(2*math.Pi)*256)) & 0xff) }

// U8ToYaw is the inverse of YawToU8.
func U8ToYaw(b uint8) float64 { return float64(b) / 256 * 2 * math.Pi }

// YawToU16 maps radians to two bytes (your own input: aim precision matters).
func YawToU16(rad float64) uint16 {
	return uint16(int(jsRound(wrapAngle(rad)/(2*math.Pi)*65536)) & 0xffff)
}

// U16ToYaw is the inverse of YawToU16.
func U16ToYaw(v uint16) float64 { return float64(v) / 65536 * 2 * math.Pi }

// PitchToU8 maps [-pi/2, pi/2] to [0, 255].
func PitchToU8(rad float64) uint8 {
	p := math.Max(-math.Pi/2, math.Min(math.Pi/2, rad))
	return uint8(jsRound((p/math.Pi + 0.5) * 255))
}

// U8ToPitch is the inverse of PitchToU8.
func U8ToPitch(b uint8) float64 { return (float64(b)/255 - 0.5) * math.Pi }

// PitchToI16 maps [-pi/2, pi/2] to [-32767, 32767].
func PitchToI16(rad float64) int16 {
	p := math.Max(-math.Pi/2, math.Min(math.Pi/2, rad))
	return int16(jsRound(p / (math.Pi / 2) * 32767))
}

// I16ToPitch is the inverse of PitchToI16.
func I16ToPitch(v int16) float64 { return float64(v) / 32767 * (math.Pi / 2) }

// jsRound matches JavaScript's Math.round (halves round toward +inf), not Go's
// math.Round (halves away from zero), so client and server quantize -x.5 the
// same way. A mismatch here showed as 1 cm reconciliation corrections.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }
