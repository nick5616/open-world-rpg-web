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
    let mut caves = 0;
    let mut towns = 0;
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
        // WP20: the towns buffer (settlements, buildings, roads, structures).
        if let Some(tw) = w.get("towns") {
            let c = worldgen::town::world(&a).unwrap();
            assert_eq!(format!("{:016x}", hash_bytes(&c.bytes)), tw["hash"].as_str().unwrap(), "{label} towns");
            towns += 1;
        }
        // WP09: cave graph, cells (plain and edited) and mouth masks.
        if let Some(cv) = w.get("caves") {
            let c = worldgen::cave::world(&a).unwrap();
            assert_eq!(format!("{:016x}", hash_bytes(&c.graph)), cv["graph"]["hash"].as_str().unwrap(), "{label} cave graph");
            for cell in cv["cells"].as_array().unwrap().iter().take(max_chunks) {
                let (cx, cy, cz) = (cell["cx"].as_i64().unwrap() as i32, cell["cy"].as_i64().unwrap() as i32, cell["cz"].as_i64().unwrap() as i32);
                let out = worldgen::cave::cell::build(&a, &c.world, cx, cy, cz, &[]).unwrap();
                assert_eq!(format!("{:016x}", hash_bytes(&out)), cell["hash"].as_str().unwrap(), "{label} cave ({cx},{cy},{cz})");
                caves += 1;
            }
            for e in cv["edited"].as_array().unwrap() {
                let edits: Vec<worldgen::cave::cell::Edit> = e["edits"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| worldgen::cave::cell::Edit {
                        vein_id: x["veinId"].as_str().unwrap().parse().unwrap(),
                        x: x["x"].as_f64().unwrap() as f32 as f64,
                        y: x["y"].as_f64().unwrap() as f32 as f64,
                        z: x["z"].as_f64().unwrap() as f32 as f64,
                        r: x["r"].as_f64().unwrap() as f32 as f64,
                    })
                    .collect();
                let (cx, cy, cz) = (e["cx"].as_i64().unwrap() as i32, e["cy"].as_i64().unwrap() as i32, e["cz"].as_i64().unwrap() as i32);
                let out = worldgen::cave::cell::build(&a, &c.world, cx, cy, cz, &edits).unwrap();
                assert_eq!(format!("{:016x}", hash_bytes(&out)), e["hash"].as_str().unwrap(), "{label} edited cave");
                caves += 1;
            }
            for m in cv["masks"].as_array().unwrap() {
                let out = worldgen::cave::mask::build(&c.world, m["cx"].as_i64().unwrap() as i32, m["cz"].as_i64().unwrap() as i32);
                assert_eq!(format!("{:016x}", hash_bytes(&out)), m["hash"].as_str().unwrap(), "{label} cave mask");
            }
        }
    }
    println!("[golden:native] {checked} chunks, {caves} cave cells, {towns} town worlds match");
}
