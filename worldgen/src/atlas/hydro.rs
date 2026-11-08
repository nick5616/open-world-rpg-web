//! Hydrology on the macro grid: priority-flood depression filling (Barnes,
//! Lehman, Mulla 2014) gives every node a downstream neighbor, lakes where
//! the fill is deep, and a topological order for flow accumulation. Rivers
//! are nodes whose upstream area passes a threshold set by `riverDensity`.
//!
//! Ties in the priority queue break on node index so the result never
//! depends on heap internals (determinism).

use super::format::{idx, N, NN, RES};
use super::World;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

/// D8 neighbor offsets; FLOW stores the index into this table.
pub const D8: [(i32, i32); 8] = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)];
pub const NO_FLOW: u8 = 255;

#[derive(PartialEq)]
struct Item {
    h: f64,
    k: usize,
}
impl Eq for Item {}
impl Ord for Item {
    fn cmp(&self, o: &Self) -> Ordering {
        // BinaryHeap is a max-heap; reverse for lowest-first.
        o.h.total_cmp(&self.h).then_with(|| o.k.cmp(&self.k))
    }
}
impl PartialOrd for Item {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// Lakes shallower than this are just filled flats, not water bodies.
const MIN_LAKE_DEPTH: f64 = 0.75;

pub fn run(w: &mut World) {
    let sea_y = w.sea_y;
    let h = &w.h;
    let mut filled = vec![0.0f64; NN];
    let mut done = vec![false; NN];
    let mut flow = vec![NO_FLOW; NN];
    let mut order = Vec::with_capacity(NN);
    let mut heap = BinaryHeap::new();
    for j in 0..N {
        for i in 0..N {
            if i == 0 || j == 0 || i == N - 1 || j == N - 1 {
                let k = idx(i, j);
                filled[k] = h[k];
                done[k] = true;
                heap.push(Item { h: h[k], k });
            }
        }
    }
    while let Some(Item { h: hc, k }) = heap.pop() {
        order.push(k);
        let (ci, cj) = ((k % N) as i32, (k / N) as i32);
        for (d, &(dx, dz)) in D8.iter().enumerate() {
            let (ni, nj) = (ci + dx, cj + dz);
            if ni < 0 || nj < 0 || ni >= N as i32 || nj >= N as i32 {
                continue;
            }
            let nk = idx(ni as usize, nj as usize);
            if done[nk] {
                continue;
            }
            done[nk] = true;
            // The tiny epsilon keeps filled flats draining in a defined direction.
            let eps = if dx != 0 && dz != 0 { 1.4e-3 } else { 1e-3 };
            filled[nk] = h[nk].max(hc + eps);
            // Flow from the neighbor back to the node that reached it.
            flow[nk] = ((d + 4) % 8) as u8;
            heap.push(Item { h: filled[nk], k: nk });
        }
    }

    let mut sea = vec![false; NN];
    let mut lake = vec![false; NN];
    let mut water = vec![sea_y; NN];
    for k in 0..NN {
        if filled[k] < sea_y {
            sea[k] = true;
        } else if filled[k] - h[k] > MIN_LAKE_DEPTH {
            lake[k] = true;
            water[k] = filled[k];
        }
    }

    // Accumulate upstream area (in nodes) from the highest node down.
    let mut acc = vec![0.0f64; NN];
    for &k in order.iter().rev() {
        if !sea[k] {
            acc[k] += 1.0;
        }
        if flow[k] != NO_FLOW {
            let (dx, dz) = D8[flow[k] as usize];
            let dk = idx(((k % N) as i32 + dx) as usize, ((k / N) as i32 + dz) as usize);
            acc[dk] += acc[k];
        }
    }

    // riverDensity 0 -> only major rivers (~0.27 km2 catchment), 1 -> many streams.
    let threshold = 260.0 + (45.0 - 260.0) * w.spec.river_density;
    let mut river_w = vec![0u8; NN];
    let mut hc = h.clone();
    for k in 0..NN {
        if sea[k] || lake[k] || acc[k] < threshold || flow[k] == NO_FLOW {
            continue;
        }
        let width = (2.5 + 0.55 * libm::sqrt(acc[k])).clamp(3.0, 22.0);
        river_w[k] = libm::round(width) as u8;
        // Rivers run on the filled surface, sunk a little so the macro
        // surface already forms a valley before the chunk pass cuts the channel.
        hc[k] = filled[k] - (0.6 + 0.12 * width);
    }
    // Quantize to f32 now: every later stage (and the chunk pass, which reads
    // the stored f32 grid) then sees the same heights.
    for v in hc.iter_mut() {
        *v = *v as f32 as f64;
    }
    for v in water.iter_mut() {
        *v = *v as f32 as f64;
    }

    let mut slope = vec![0.0f64; NN];
    for j in 0..N {
        for i in 0..N {
            let l = hc[idx(i.saturating_sub(1), j)];
            let r = hc[idx((i + 1).min(N - 1), j)];
            let u = hc[idx(i, j.saturating_sub(1))];
            let d = hc[idx(i, (j + 1).min(N - 1))];
            let gx = (r - l) / (2.0 * RES);
            let gz = (d - u) / (2.0 * RES);
            slope[idx(i, j)] = libm::atan(libm::sqrt(gx * gx + gz * gz)) * (180.0 / core::f64::consts::PI);
        }
    }

    w.h = hc;
    w.filled = filled;
    w.flow = flow;
    w.acc = acc;
    w.sea = sea;
    w.lake = lake;
    w.water = water;
    w.river_w = river_w;
    w.slope = slope;
}

/// Downstream node of `k`, if any.
pub fn downstream(flow: &[u8], k: usize) -> Option<usize> {
    let f = flow[k];
    if f == NO_FLOW {
        return None;
    }
    let (dx, dz) = D8[f as usize];
    let ni = (k % N) as i32 + dx;
    let nj = (k / N) as i32 + dz;
    if ni < 0 || nj < 0 || ni >= N as i32 || nj >= N as i32 {
        return None;
    }
    Some(idx(ni as usize, nj as usize))
}
