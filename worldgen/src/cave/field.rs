//! The cave density field (spec 7 step 2): signed distance-like values,
//! negative in air, positive in rock. Chambers are ellipsoids with a flat
//! floor, tunnels are swept capsules (optionally stretched vertically into
//! ravines or shafts) with a flat floor, joined with a smooth minimum, then
//! displaced by wall noise. Everything is a pure function of the world
//! position, so neighboring cells (and every host) agree on shared samples.
//!
//! Why flat floors: players walk on these surfaces. A pure capsule has a
//! V-shaped bottom that the movement step reads as a ridge between two steep
//! slopes; cutting it at 60% of the radius below the axis leaves a floor
//! about 1.6 r wide. Floors get only 15% of the wall noise for the same
//! reason (bumps, not boulders).

use super::noise3::wall_noise;

/// Smooth-union radius: tunnels flare into chambers over ~2.5 m instead of
/// meeting them at a crease.
pub const SMOOTH_K: f64 = 2.5;
/// Peak wall-noise displacement in meters (also the margin every clearance
/// check adds, so noise never breaks a planned roof).
pub const NOISE_AMP: f64 = 1.3;
/// Floor noise relative to wall noise.
pub const FLOOR_NOISE: f64 = 0.15;
/// Value used for "far from any cave" (clamped rock).
pub const FAR: f64 = 8.0;

pub const ELEM_CHAMBER: u8 = 0;
pub const ELEM_SEGMENT: u8 = 1;

/// One primitive of a cave system, in world meters.
#[derive(Clone, Copy, Debug)]
pub struct Elem {
    pub kind: u8,
    /// Chamber: center. Segment: start point of the axis.
    pub a: [f64; 3],
    /// Segment: end point of the axis (unused for chambers).
    pub b: [f64; 3],
    /// Chamber: horizontal radius. Segment: radius (horizontal).
    pub r: f64,
    /// Chamber: vertical radius. Segment: vertical stretch factor (1 = round).
    pub ry: f64,
    /// Chamber: absolute floor height. Segment: floor depth below the axis
    /// as a fraction of r (0.6 tunnels, 0.5 ravines; shafts use a huge value
    /// so they have no floor).
    pub floor: f64,
    /// Axis-aligned bounds of the air this element can produce, including
    /// noise and smooth-union margins: [min x, min y, min z, max x, max y, max z].
    pub aabb: [f64; 6],
    pub system: u16,
    /// Share of the wall noise this element takes. Narrow tunnels take at
    /// most 35% of their radius, so noise can roughen a 2 m tunnel but never
    /// pinch it shut (an early build closed deep ravines this way).
    pub nk: f64,
}

impl Elem {
    pub fn chamber(c: [f64; 3], rx: f64, ry: f64, floor: f64, system: u16) -> Elem {
        let m = NOISE_AMP + SMOOTH_K;
        Elem {
            kind: ELEM_CHAMBER,
            a: c,
            b: c,
            r: rx,
            ry,
            floor,
            aabb: [c[0] - rx - m, floor - m, c[2] - rx - m, c[0] + rx + m, c[1] + ry + m, c[2] + rx + m],
            system,
            nk: (0.35 * rx.min(ry) / NOISE_AMP).min(1.0),
        }
    }

    pub fn segment(a: [f64; 3], b: [f64; 3], r: f64, stretch: f64, floor_k: f64, system: u16) -> Elem {
        let m = NOISE_AMP + SMOOTH_K;
        let ry = r * stretch;
        Elem {
            kind: ELEM_SEGMENT,
            a,
            b,
            r,
            ry: stretch,
            floor: floor_k,
            aabb: [
                a[0].min(b[0]) - r - m,
                a[1].min(b[1]) - ry - m,
                a[2].min(b[2]) - r - m,
                a[0].max(b[0]) + r + m,
                a[1].max(b[1]) + ry + m,
                a[2].max(b[2]) + r + m,
            ],
            system,
            nk: (0.35 * r / NOISE_AMP).min(1.0),
        }
    }

    #[inline]
    pub fn overlaps(&self, b: &[f64; 6]) -> bool {
        self.aabb[0] <= b[3] && self.aabb[3] >= b[0] && self.aabb[1] <= b[4] && self.aabb[4] >= b[1] && self.aabb[2] <= b[5] && self.aabb[5] >= b[2]
    }

    #[inline]
    pub fn contains(&self, p: [f64; 3]) -> bool {
        p[0] >= self.aabb[0] && p[0] <= self.aabb[3] && p[1] >= self.aabb[1] && p[1] <= self.aabb[4] && p[2] >= self.aabb[2] && p[2] <= self.aabb[5]
    }

    /// Distance part (before noise) and floor part of this element at p.
    /// Air needs both negative.
    #[inline]
    pub fn parts(&self, p: [f64; 3]) -> (f64, f64) {
        if self.kind == ELEM_CHAMBER {
            let dx = p[0] - self.a[0];
            let dy = p[1] - self.a[1];
            let dz = p[2] - self.a[2];
            let (rx, ry) = (self.r, self.ry);
            // Inigo Quilez's ellipsoid distance bound: exact on the surface,
            // a good-enough gradient elsewhere, two square roots.
            let qx = dx / rx;
            let qy = dy / ry;
            let qz = dz / rx;
            let k0 = libm::sqrt(qx * qx + qy * qy + qz * qz);
            let sx = dx / (rx * rx);
            let sy = dy / (ry * ry);
            let sz = dz / (rx * rx);
            let k1 = libm::sqrt(sx * sx + sy * sy + sz * sz);
            let d = if k1 > 0.0 { k0 * (k0 - 1.0) / k1 } else { -ry.min(rx) };
            (d, self.floor - p[1])
        } else {
            // Capsule in a space where y is divided by the stretch, so a
            // ravine (stretch > 1) is a tall, narrow slot.
            let s = self.ry;
            let (ax, ay, az) = (self.a[0], self.a[1] / s, self.a[2]);
            let (bx, by, bz) = (self.b[0], self.b[1] / s, self.b[2]);
            let (px, py, pz) = (p[0], p[1] / s, p[2]);
            let (ex, ey, ez) = (bx - ax, by - ay, bz - az);
            let l2 = ex * ex + ey * ey + ez * ez;
            let t = if l2 > 0.0 {
                (((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let cx = ax + ex * t - px;
            let cy = ay + ey * t - py;
            let cz = az + ez * t - pz;
            let d = libm::sqrt(cx * cx + cy * cy + cz * cz) - self.r;
            let axis_y = self.a[1] + (self.b[1] - self.a[1]) * t;
            (d, axis_y - self.floor * self.r - p[1])
        }
    }
}

/// Polynomial smooth minimum (k = blend width in meters).
#[inline]
pub fn smin(a: f64, b: f64, k: f64) -> f64 {
    let h = (k - libm::fabs(a - b)).max(0.0) / k;
    a.min(b) - h * h * k * 0.25
}

/// Field of a list of elements at p (noise scaled by `noise_scale`, 0..1).
/// `elems` must be in a fixed order (system, element index): the smooth
/// union is not associative in floating point.
pub fn eval(elems: &[Elem], seed: u32, p: [f64; 3], noise_scale: f64) -> f64 {
    // Cheap pass first: most samples in a cell are deep in rock, far from
    // every element, and need no noise at all.
    let mut nearest = FAR;
    for e in elems {
        if e.contains(p) {
            let (d, f) = e.parts(p);
            nearest = nearest.min(d.max(f));
        }
    }
    let amp = NOISE_AMP * noise_scale;
    if nearest > amp + SMOOTH_K + 0.5 {
        return FAR;
    }
    let n = if amp > 0.0 { wall_noise(seed, p[0], p[1], p[2]) * amp } else { 0.0 };
    let mut f = FAR;
    let mut first = true;
    for e in elems {
        if !e.contains(p) {
            continue;
        }
        let (d, fl) = e.parts(p);
        let ne = n * e.nk;
        let v = (d + ne).max(fl + FLOOR_NOISE * ne);
        if first {
            f = v;
            first = false;
        } else {
            f = smin(f, v, SMOOTH_K);
        }
    }
    f.min(FAR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chamber_air_inside_rock_outside() {
        let e = Elem::chamber([0.0, 10.0, 0.0], 8.0, 5.0, 7.0, 0);
        assert!(eval(&[e], 1, [0.0, 10.0, 0.0], 0.0) < 0.0);
        assert!(eval(&[e], 1, [0.0, 6.0, 0.0], 0.0) > 0.0, "below the flat floor is rock");
        assert!(eval(&[e], 1, [12.0, 10.0, 0.0], 0.0) > 0.0);
    }

    #[test]
    fn segment_floor_and_stretch() {
        let e = Elem::segment([0.0, 0.0, 0.0], [20.0, 0.0, 0.0], 3.0, 1.0, 0.6, 0);
        assert!(eval(&[e], 1, [10.0, 0.0, 0.0], 0.0) < 0.0);
        assert!(eval(&[e], 1, [10.0, -2.0, 0.0], 0.0) > 0.0, "floor at -1.8");
        let r = Elem::segment([0.0, 0.0, 0.0], [20.0, 0.0, 0.0], 2.0, 3.0, 0.5, 0);
        assert!(eval(&[r], 1, [10.0, 5.0, 0.0], 0.0) < 0.0, "ravine is tall");
        assert!(eval(&[r], 1, [10.0, 0.0, 2.5], 0.0) > 0.0, "and narrow");
    }

    #[test]
    fn smooth_union_is_at_most_min() {
        for i in 0..100 {
            let a = i as f64 * 0.1 - 5.0;
            let b = 2.0 - i as f64 * 0.07;
            assert!(smin(a, b, SMOOTH_K) <= a.min(b));
        }
    }
}
