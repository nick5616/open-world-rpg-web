//! Geometry helpers for the towns pass: oriented rectangles in xz, the
//! terrain sampler over the exact f32 collision lattice, and box emitters.

use super::{bf, Box3};
use crate::atlas::format::Atlas;
use crate::ground::Ground;

/// Oriented rectangle in xz: centre, local u axis (c, s), half extents.
#[derive(Clone, Copy, Debug)]
pub struct Obb {
    pub cx: f64,
    pub cz: f64,
    pub c: f64,
    pub s: f64,
    pub hx: f64,
    pub hz: f64,
}

impl Obb {
    pub fn new(cx: f64, cz: f64, yaw: f64, hx: f64, hz: f64) -> Obb {
        Obb {
            cx,
            cz,
            c: libm::cos(yaw),
            s: libm::sin(yaw),
            hx,
            hz,
        }
    }

    /// World point of local (u, v).
    #[inline]
    pub fn at(&self, u: f64, v: f64) -> (f64, f64) {
        (self.cx + u * self.c - v * self.s, self.cz + u * self.s + v * self.c)
    }

    /// Local (u, v) of a world point.
    #[inline]
    pub fn local(&self, x: f64, z: f64) -> (f64, f64) {
        let dx = x - self.cx;
        let dz = z - self.cz;
        (dx * self.c + dz * self.s, dz * self.c - dx * self.s)
    }

    pub fn contains(&self, x: f64, z: f64, pad: f64) -> bool {
        let (u, v) = self.local(x, z);
        u.abs() <= self.hx + pad && v.abs() <= self.hz + pad
    }

    pub fn corners(&self) -> [(f64, f64); 4] {
        [
            self.at(-self.hx, -self.hz),
            self.at(self.hx, -self.hz),
            self.at(self.hx, self.hz),
            self.at(-self.hx, self.hz),
        ]
    }

    pub fn radius(&self) -> f64 {
        libm::sqrt(self.hx * self.hx + self.hz * self.hz)
    }

    /// Separating-axis overlap test, with `pad` added to both rectangles.
    pub fn overlaps(&self, o: &Obb, pad: f64) -> bool {
        let dx = o.cx - self.cx;
        let dz = o.cz - self.cz;
        if dx * dx + dz * dz > (self.radius() + o.radius() + 2.0 * pad) * (self.radius() + o.radius() + 2.0 * pad) {
            return false;
        }
        for &(ax, az) in &[(self.c, self.s), (-self.s, self.c), (o.c, o.s), (-o.s, o.c)] {
            let ra = (self.hx + pad) * (self.c * ax + self.s * az).abs() + (self.hz + pad) * (-self.s * ax + self.c * az).abs();
            let rb = (o.hx + pad) * (o.c * ax + o.s * az).abs() + (o.hz + pad) * (-o.s * ax + o.c * az).abs();
            if (dx * ax + dz * az).abs() > ra + rb {
                return false;
            }
        }
        true
    }

    /// Distance from the rectangle to a segment (0 if they touch), sampled.
    pub fn seg_clear(&self, ax: f64, az: f64, bx: f64, bz: f64, clear: f64) -> bool {
        let len = libm::sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
        let n = (len / 1.5) as usize + 1;
        for i in 0..=n {
            let t = i as f64 / n as f64;
            if self.contains(ax + (bx - ax) * t, az + (bz - az) * t, clear) {
                return false;
            }
        }
        true
    }
}

/// Terrain statistics over a rectangle, on the exact f32 lattice the
/// collision mesh interpolates (so a floor above `max` is above the ground
/// everywhere inside the rectangle).
pub struct Span {
    pub min: f64,
    pub max: f64,
    pub wet: bool,
    pub max_water: f64,
}

pub struct Terrain<'a> {
    pub a: &'a Atlas<'a>,
}

impl<'a> Terrain<'a> {
    pub fn new(a: &'a Atlas<'a>) -> Terrain<'a> {
        Terrain { a }
    }

    /// Exact collision height (same as the `collision_height` export).
    pub fn height(&self, x: f64, z: f64) -> f64 {
        crate::ground::collision_height(self.a, x, z)
    }

    /// Lattice extremes over the integer points covering `o` padded by 1 m.
    pub fn span(&self, o: &Obb, pad: f64) -> Span {
        let r = o.radius() + pad + 1.0;
        let x0 = libm::floor(o.cx - r);
        let z0 = libm::floor(o.cz - r);
        let x1 = libm::ceil(o.cx + r);
        let z1 = libm::ceil(o.cz + r);
        let g = Ground::new(self.a, x0, z0, x1, z1);
        let mut sp = Span {
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            wet: false,
            max_water: f64::NEG_INFINITY,
        };
        let mut z = z0;
        while z <= z1 {
            let mut x = x0;
            while x <= x1 {
                if o.contains(x, z, pad + 1.0) {
                    let (h, w) = g.sample(x, z);
                    let h = h as f32 as f64;
                    let w = w as f32 as f64;
                    sp.min = sp.min.min(h);
                    sp.max = sp.max.max(h);
                    if w > h + 0.05 {
                        sp.wet = true;
                        sp.max_water = sp.max_water.max(w);
                    }
                }
                x += 1.0;
            }
            z += 1.0;
        }
        if !sp.min.is_finite() {
            let h = self.height(o.cx, o.cz);
            sp.min = h;
            sp.max = h;
        }
        sp
    }

    /// Ground sample (height, water) at one point, not on the lattice.
    pub fn sample(&self, x: f64, z: f64) -> (f64, f64) {
        let g = Ground::new(self.a, x - 1.0, z - 1.0, x + 1.0, z + 1.0);
        g.sample(x, z)
    }
}

/// Push a box from a rectangle with a flat top.
pub fn push_flat(out: &mut Vec<Box3>, o: &Obb, y0: f64, top: f64, kind: u8, flags: u8, owner: u16) {
    push_ramp(out, o, y0, top, top, kind, flags, owner);
}

/// Push a box whose top runs from `t1` at u = -hx to `t2` at u = +hx.
#[allow(clippy::too_many_arguments)]
pub fn push_ramp(out: &mut Vec<Box3>, o: &Obb, y0: f64, t1: f64, t2: f64, kind: u8, flags: u8, owner: u16) {
    debug_assert!(y0.is_finite() && t1.is_finite() && t2.is_finite());
    out.push(Box3 {
        cx: o.cx as f32,
        cz: o.cz as f32,
        c: o.c as f32,
        s: o.s as f32,
        hx: o.hx as f32,
        hz: o.hz as f32,
        y0: y0 as f32,
        y1: t1 as f32,
        y2: t2 as f32,
        kind,
        flags,
        owner,
    });
}

/// A sub-rectangle of `o` in its local frame: centre (u, v), half (hu, hv).
pub fn sub(o: &Obb, u: f64, v: f64, hu: f64, hv: f64) -> Obb {
    let (cx, cz) = o.at(u, v);
    Obb {
        cx,
        cz,
        c: o.c,
        s: o.s,
        hx: hu,
        hz: hv,
    }
}

/// The same rectangle turned a quarter (local u becomes the old v): used
/// for roof halves whose slope runs along the other axis.
pub fn quarter(o: &Obb) -> Obb {
    Obb {
        cx: o.cx,
        cz: o.cz,
        c: -o.s,
        s: o.c,
        hx: o.hz,
        hz: o.hx,
    }
}

/// Solid wall rectangle (no walkable top).
pub fn wall(out: &mut Vec<Box3>, o: &Obb, y0: f64, top: f64, kind: u8, owner: u16) {
    push_flat(out, o, y0, top, kind, bf::SOLID, owner);
}

/// Yaw as a fraction of a turn x 65536.
pub fn yaw16(yaw: f64) -> u16 {
    let t = yaw / (2.0 * core::f64::consts::PI);
    let f = t - libm::floor(t);
    ((f * 65536.0) as u32 & 0xFFFF) as u16
}

pub fn dist(ax: f64, az: f64, bx: f64, bz: f64) -> f64 {
    libm::sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az))
}
