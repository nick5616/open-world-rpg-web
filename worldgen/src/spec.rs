//! WorldSpec: `spec_from_seed` (spec 6, "from the seed alone"), parsing and
//! validation. The struct itself is generated from
//! contracts/worldspec.schema.json into `gen::worldspec`.

use crate::gen::worldspec::{BiomeWeights, ElementWeights, WorldSpec, LOOT_THEMES_VALUES, NAME_GRAMMAR_VALUES, PALETTE_VALUES, RANGES};
use crate::names;
use crate::rng::Seq;

pub const BIOME_NAMES: [&str; 6] = ["meadow", "forest", "highlands", "snowpeak", "badlands", "wetland"];
pub const ELEMENT_NAMES: [&str; 8] = ["fire", "ice", "lightning", "earth", "wind", "light", "dark", "void"];

const STREAM_SPEC: u64 = 0x5350_4543; // "SPEC"

/// Round to 3 decimals so generated specs read cleanly in the creator tool.
/// `k / 1000.0` is a correctly rounded division, so the result is the same
/// f64 on every host and serializes to the same short decimal.
fn r3(v: f64) -> f64 {
    libm::round(v * 1000.0) / 1000.0
}

/// Pick every WorldSpec field from the seed alone, within ranges chosen to
/// give a varied but always playable world: every biome present, mountains
/// tall enough to climb and glide from, rivers and settlements in every
/// region. The full schema range stays available to presets and the creator.
pub fn spec_from_seed(seed: u64) -> WorldSpec {
    let mut s = Seq::new(seed, STREAM_SPEC);
    let mut f = |lo: f64, hi: f64| r3(s.range(lo, hi));
    let sea_level = f(0.2, 0.6);
    let land_fraction = f(0.5, 0.78);
    let mountain_height = f(0.4, 0.9);
    let roughness = f(0.3, 0.7);
    let plateaus = f(0.0, 0.6);
    let river_density = f(0.35, 0.8);
    let temperature_bias = f(-0.35, 0.35);
    let moisture_bias = f(-0.35, 0.35);
    let storm_frequency = f(0.1, 0.6);
    // Floors of 0.35 keep every biome in play; the spread gives each world a lean.
    let biome_weights = BiomeWeights {
        meadow: f(0.5, 1.0),
        forest: f(0.45, 1.0),
        highlands: f(0.35, 1.0),
        snowpeak: f(0.35, 1.0),
        badlands: f(0.35, 1.0),
        wetland: f(0.35, 1.0),
    };
    let element_weights = ElementWeights {
        fire: f(0.2, 1.0),
        ice: f(0.2, 1.0),
        lightning: f(0.2, 1.0),
        earth: f(0.2, 1.0),
        wind: f(0.2, 1.0),
        light: f(0.2, 1.0),
        dark: f(0.2, 1.0),
        r#void: f(0.05, 0.4),
    };
    let cave_density = f(0.3, 0.8);
    let cave_max_depth = libm::round(f(128.0, 256.0));
    let gem_rarity_curve = f(1.0, 2.2);
    let ore_abundance = f(0.3, 0.8);
    let danger_curve = f(0.3, 0.7);
    let enemy_density = f(0.3, 0.7);
    let demon_intensity = f(0.3, 0.7);
    let flammability = f(0.3, 0.8);
    let night_length = f(0.3, 0.45);
    let settlement_density = f(0.3, 0.8);
    let structure_density = f(0.35, 0.8);
    let wind_direction = s.below(360) as i64;
    let palette = PALETTE_VALUES[s.below(PALETTE_VALUES.len())].to_string();
    let n_themes = 2 + s.below(3);
    let mut themes: Vec<String> = Vec::new();
    while themes.len() < n_themes {
        let t = LOOT_THEMES_VALUES[s.below(LOOT_THEMES_VALUES.len())];
        if !themes.iter().any(|x| x == t) {
            themes.push(t.to_string());
        }
    }
    let g = s.below(NAME_GRAMMAR_VALUES.len());
    let name = names::world_name(g, &mut s);
    WorldSpec {
        spec_version: 1,
        name,
        seed: seed.to_string(),
        sea_level,
        land_fraction,
        mountain_height,
        roughness,
        plateaus,
        river_density,
        temperature_bias,
        moisture_bias,
        wind_direction,
        storm_frequency,
        biome_weights,
        element_weights,
        cave_density,
        cave_max_depth,
        gem_rarity_curve,
        ore_abundance,
        danger_curve,
        enemy_density,
        demon_intensity,
        flammability,
        night_length,
        settlement_density,
        structure_density,
        palette,
        loot_themes: themes,
        name_grammar: NAME_GRAMMAR_VALUES[g].to_string(),
    }
}

fn field_value(s: &WorldSpec, field: &str) -> Option<f64> {
    let b = &s.biome_weights;
    let e = &s.element_weights;
    Some(match field {
        "specVersion" => s.spec_version as f64,
        "seaLevel" => s.sea_level,
        "landFraction" => s.land_fraction,
        "mountainHeight" => s.mountain_height,
        "roughness" => s.roughness,
        "plateaus" => s.plateaus,
        "riverDensity" => s.river_density,
        "temperatureBias" => s.temperature_bias,
        "moistureBias" => s.moisture_bias,
        "windDirection" => s.wind_direction as f64,
        "stormFrequency" => s.storm_frequency,
        "caveDensity" => s.cave_density,
        "caveMaxDepth" => s.cave_max_depth,
        "gemRarityCurve" => s.gem_rarity_curve,
        "oreAbundance" => s.ore_abundance,
        "dangerCurve" => s.danger_curve,
        "enemyDensity" => s.enemy_density,
        "demonIntensity" => s.demon_intensity,
        "flammability" => s.flammability,
        "nightLength" => s.night_length,
        "settlementDensity" => s.settlement_density,
        "structureDensity" => s.structure_density,
        "biomeWeights.meadow" => b.meadow,
        "biomeWeights.forest" => b.forest,
        "biomeWeights.highlands" => b.highlands,
        "biomeWeights.snowpeak" => b.snowpeak,
        "biomeWeights.badlands" => b.badlands,
        "biomeWeights.wetland" => b.wetland,
        "elementWeights.fire" => e.fire,
        "elementWeights.ice" => e.ice,
        "elementWeights.lightning" => e.lightning,
        "elementWeights.earth" => e.earth,
        "elementWeights.wind" => e.wind,
        "elementWeights.light" => e.light,
        "elementWeights.dark" => e.dark,
        "elementWeights.void" => e.r#void,
        _ => return None,
    })
}

/// Validate against the schema rules. The generator rejects rather than
/// clamps: clamping is the creator tool's job (spec 6), and silently
/// reinterpreting a spec here would make two tools disagree about a world.
pub fn validate(s: &WorldSpec) -> Result<(), String> {
    for &(field, lo, hi, _int) in RANGES {
        let v = field_value(s, field).ok_or_else(|| format!("unknown range field {field}"))?;
        if !v.is_finite() || v < lo || v > hi {
            return Err(format!("{field}={v} outside [{lo}, {hi}]"));
        }
    }
    let n = s.name.len();
    if !(3..=40).contains(&n) || !s.name.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '\'' || c == '-') {
        return Err(format!("name {:?} must be 3-40 chars of [A-Za-z0-9' -]", s.name));
    }
    if s.seed.is_empty() || s.seed.len() > 20 || !s.seed.bytes().all(|c| c.is_ascii_digit()) || s.seed.parse::<u64>().is_err() {
        return Err(format!("seed {:?} is not a uint64 decimal string", s.seed));
    }
    if !PALETTE_VALUES.contains(&s.palette.as_str()) {
        return Err(format!("palette {:?} not in enum", s.palette));
    }
    if !NAME_GRAMMAR_VALUES.contains(&s.name_grammar.as_str()) {
        return Err(format!("nameGrammar {:?} not in enum", s.name_grammar));
    }
    if s.loot_themes.len() > 4 {
        return Err("lootThemes has more than 4 items".into());
    }
    for (i, t) in s.loot_themes.iter().enumerate() {
        if !LOOT_THEMES_VALUES.contains(&t.as_str()) {
            return Err(format!("lootTheme {t:?} not in enum"));
        }
        if s.loot_themes[..i].contains(t) {
            return Err(format!("lootTheme {t:?} repeated"));
        }
    }
    Ok(())
}

pub fn parse(json: &[u8]) -> Result<WorldSpec, String> {
    let spec: WorldSpec = serde_json::from_slice(json).map_err(|e| format!("spec json: {e}"))?;
    validate(&spec)?;
    Ok(spec)
}

/// Canonical bytes: serde's field order and ryu's shortest float form, so the
/// same spec always serializes (and hashes) the same way.
pub fn to_json(s: &WorldSpec) -> Vec<u8> {
    serde_json::to_vec(s).expect("WorldSpec always serializes")
}

pub fn biome_weight_array(s: &WorldSpec) -> [f64; 6] {
    let b = &s.biome_weights;
    [b.meadow, b.forest, b.highlands, b.snowpeak, b.badlands, b.wetland]
}

pub fn element_weight_array(s: &WorldSpec) -> [f64; 8] {
    let e = &s.element_weights;
    [e.fire, e.ice, e.lightning, e.earth, e.wind, e.light, e.dark, e.r#void]
}

/// Bitmask of loot themes by their index in LOOT_THEMES_VALUES.
pub fn loot_theme_mask(s: &WorldSpec) -> u32 {
    s.loot_themes
        .iter()
        .filter_map(|t| LOOT_THEMES_VALUES.iter().position(|v| v == t))
        .fold(0u32, |m, i| m | (1 << i))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_seed_is_valid_and_deterministic() {
        for seed in [0u64, 1, 42, 1234567, u64::MAX] {
            let a = spec_from_seed(seed);
            validate(&a).unwrap();
            assert_eq!(a, spec_from_seed(seed));
            assert_eq!(a.seed, seed.to_string());
            let back = parse(&to_json(&a)).unwrap();
            assert_eq!(a, back);
        }
    }

    #[test]
    fn seeds_differ() {
        assert_ne!(spec_from_seed(1).name, spec_from_seed(2).name);
    }

    #[test]
    fn rejects_out_of_range() {
        let mut s = spec_from_seed(3);
        s.land_fraction = 0.95;
        assert!(validate(&s).is_err());
        let mut s = spec_from_seed(3);
        s.palette = "neon".into();
        assert!(validate(&s).is_err());
    }
}
