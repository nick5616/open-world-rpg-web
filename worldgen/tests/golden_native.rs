//! Native (x86_64/aarch64) build against the wasm golden table. Not one of
//! the three required hosts, but it proves the source has no wasm-only
//! behavior, and debug builds run the NaN debug_asserts over real worlds.
//! Debug builds check a subset to keep `cargo test` quick.

use serde_json::Value;
use worldgen::atlas::{self, format::Atlas};
use worldgen::gen::worldspec::WorldSpec;
use worldgen::{chunk, ground, hash_bytes};

#[test]
fn native_matches_golden() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/golden/golden.json");
    let raw = std::fs::read_to_string(path).expect("golden.json");
    let g: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        g["genVersion"].as_u64().unwrap(),
        worldgen::GEN_VERSION as u64,
        "golden table is for another genVersion"
    );
    let (max_worlds, max_chunks) = if cfg!(debug_assertions) { (2, 25) } else { (usize::MAX, usize::MAX) };
    let mut checked = 0;
    for w in g["worlds"].as_array().unwrap().iter().take(max_worlds) {
        let spec: WorldSpec = serde_json::from_value(w["spec"].clone()).unwrap();
        let seed: u64 = w["seed"].as_str().unwrap().parse().unwrap();
        let bytes = atlas::build(&spec, seed).unwrap();
        let label = w["label"].as_str().unwrap();
        assert_eq!(format!("{:016x}", hash_bytes(&bytes)), w["atlas"]["hash"].as_str().unwrap(), "{label} atlas");
        let a = Atlas::parse(&bytes).unwrap();
        for c in w["chunks"].as_array().unwrap().iter().take(max_chunks) {
            let (cx, cz, lod) = (
                c["cx"].as_i64().unwrap() as i32,
                c["cz"].as_i64().unwrap() as i32,
                c["lod"].as_u64().unwrap() as u32,
            );
            let out = chunk::build(&a, cx, cz, lod).unwrap();
            assert_eq!(
                format!("{:016x}", hash_bytes(&out)),
                c["hash"].as_str().unwrap(),
                "{label} chunk ({cx},{cz},{lod})"
            );
            checked += 1;
        }
        for p in w["collision"].as_array().unwrap() {
            let h = ground::collision_height(&a, p["x"].as_f64().unwrap(), p["z"].as_f64().unwrap());
            assert_eq!(format!("{:016x}", h.to_bits()), p["h"].as_str().unwrap(), "{label} collision");
        }
    }
    println!("[golden:native] {checked} chunks match");
}
