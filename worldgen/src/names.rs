//! Seeded name grammars (spec 6: place and item names come from grammars in
//! the crate, never from a model). Five syllable sets match the schema's
//! `nameGrammar` enum. All syllables and patterns are original; a blocklist
//! rejects any accidental hit on names from the games we are inspired by
//! (spec 2, "inspired by, never copied").

use crate::rng::Seq;

pub struct Grammar {
    onsets: &'static [&'static str],
    vowels: &'static [&'static str],
    codas: &'static [&'static str],
    /// Settlement suffixes ("{Root}{suffix}").
    suffixes: &'static [&'static str],
    /// World-name patterns; `{N}` is a proper name, `{A}` an adjective.
    world: &'static [&'static str],
}

pub const GRAMMAR_NAMES: [&str; 5] = ["pastoral", "highland", "coastal", "arcane", "austere"];

const GRAMMARS: [Grammar; 5] = [
    Grammar {
        onsets: &["b", "br", "d", "f", "h", "l", "m", "n", "p", "r", "s", "t", "w", "th", "c", "g", "ell", "al"],
        vowels: &["a", "e", "i", "o", "u", "ea", "ow", "ai", "ee", "y"],
        codas: &["n", "l", "r", "th", "m", "", "", "ck", "nd", "st", "ll"],
        suffixes: &["ford", "ham", "wick", "by", "stead", "mere", "dale", "ton", "worth", "brook", "field", "combe"],
        world: &["{N}", "The {A} Shires", "{N} Vale", "Fields of {N}", "{N}shire"],
    },
    Grammar {
        onsets: &["k", "g", "dr", "br", "cr", "st", "m", "b", "gl", "t", "d", "r", "f", "sc", "l"],
        vowels: &["a", "o", "u", "ai", "ae", "ei", "oi", "e"],
        codas: &["n", "rn", "ch", "g", "rr", "ck", "m", "", "ld", "th"],
        suffixes: &["more", "ach", "an", "dun", "crag", "ben", "loch", "gair", "fell", "ard"],
        world: &["{N}", "The {A} Fells", "Highmarch of {N}", "{N} Uplands", "The Crags of {N}"],
    },
    Grammar {
        onsets: &["s", "l", "m", "n", "v", "t", "c", "sh", "p", "r", "al", "mar"],
        vowels: &["a", "e", "i", "o", "ae", "ia", "ea", "ou"],
        codas: &["", "", "n", "s", "l", "r", "th", "ss"],
        suffixes: &["port", "haven", "shore", "mouth", "sand", "reach", "quay", "strand", "cove", "bay"],
        world: &["{N}", "The {A} Isles", "{N} Reach", "Shores of {N}", "{N} Archipelago"],
    },
    Grammar {
        onsets: &["z", "x", "v", "th", "s", "l", "qu", "y", "ae", "or", "il", "m"],
        vowels: &["a", "e", "i", "y", "ae", "io", "ul", "ea", "ai"],
        codas: &["", "th", "s", "n", "l", "r", "x", "ph"],
        suffixes: &["ith", "or", "eth", "ael", "ys", "ion", "aris", "ene", "ul", "ora"],
        world: &["{N}", "The {A} Expanse", "Realm of {N}", "{N} Sanctum", "The Veil of {N}"],
    },
    Grammar {
        onsets: &["k", "t", "v", "d", "gr", "kr", "r", "h", "sk", "br", "j", "tr"],
        vowels: &["a", "o", "u", "e", "aa", "oe", "y"],
        codas: &["", "k", "r", "n", "t", "rk", "lt", "st"],
        suffixes: &["holm", "ek", "var", "stad", "vik", "nes", "berg", "fjel", "mark", "lund"],
        world: &["{N}", "The {A} Marches", "{N} Hold", "The Steppes of {N}", "{N}mark"],
    },
];

const ADJECTIVES: &[&str] = &[
    "Amber", "Hollow", "Whispering", "Sunken", "Shattered", "Gilded", "Pale", "Verdant", "Ashen", "Windworn",
    "Silent", "Restless", "Bleak", "Moonlit", "Ironbound", "Drowsy", "Burning", "Lantern", "Thornwrapped",
    "Glimmering", "Forgotten", "Howling", "Mossy", "Copper", "Starlit", "Weeping", "Crooked", "Bright",
];

/// Landform words per biome (index = biome id).
const LANDFORMS: [&[&str]; 6] = [
    &["Fields", "Downs", "Leas", "Meadows", "Wolds"],
    &["Wood", "Weald", "Thicket", "Holt", "Greenwood"],
    &["Heights", "Fells", "Tors", "Crags", "Uplands"],
    &["Peaks", "Spires", "Teeth", "Crowns", "Icefields"],
    &["Wastes", "Barrens", "Mesas", "Scar", "Badlands"],
    &["Fens", "Marsh", "Mire", "Bog", "Sloughs"],
];

/// Lowercase substrings that must never appear in a generated name.
const BLOCKLIST: &[&str] = &[
    "hyrul", "zelda", "ganon", "hylia", "kakarik", "gerudo", "goron", "zora", "rito", "korok", "sheikah", "epona",
    "creeper", "ender", "nether", "herobrine", "steve", "valheim", "midgard", "asgard", "yggdras", "odin",
    "nazi", "fuck", "shit", "cunt", "rape", "slut", "piss",
];

pub fn grammar_index(name: &str) -> Option<usize> {
    GRAMMAR_NAMES.iter().position(|g| *g == name)
}

fn blocked(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    BLOCKLIST.iter().any(|b| lower.contains(b))
}

fn capitalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for (i, ch) in s.chars().enumerate() {
        if i == 0 {
            out.push(ch.to_ascii_uppercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// A proper name of 2 or 3 syllables, e.g. "Brellan", "Zaethys".
pub fn proper(g: usize, seq: &mut Seq) -> String {
    let gr = &GRAMMARS[g];
    for _ in 0..64 {
        let syll = if seq.unit() < 0.7 { 2 } else { 3 };
        let mut s = String::new();
        for i in 0..syll {
            s.push_str(seq.pick(gr.onsets));
            s.push_str(seq.pick(gr.vowels));
            if i == syll - 1 || seq.unit() < 0.3 {
                s.push_str(seq.pick(gr.codas));
            }
        }
        if s.len() >= 3 && s.len() <= 12 && !blocked(&s) {
            return capitalize(&s);
        }
    }
    // Unreachable in practice (64 tries); a fixed fallback keeps output total.
    String::from("Ostra")
}

pub fn adjective(seq: &mut Seq) -> &'static str {
    seq.pick(ADJECTIVES)
}

/// World display name, matching the schema pattern and 3 to 40 chars.
pub fn world_name(g: usize, seq: &mut Seq) -> String {
    let gr = &GRAMMARS[g];
    let pat = *seq.pick(gr.world);
    let n = proper(g, seq);
    let a = adjective(seq);
    let s = pat.replace("{N}", &n).replace("{A}", a);
    if s.len() > 40 {
        n
    } else {
        s
    }
}

pub fn region_name(g: usize, biome: usize, seq: &mut Seq) -> String {
    let land = *seq.pick(LANDFORMS[biome.min(5)]);
    match seq.below(3) {
        0 => format!("The {} {}", adjective(seq), land),
        1 => format!("{} {}", proper(g, seq), land),
        _ => format!("The {} of {}", land, proper(g, seq)),
    }
}

pub fn settlement_name(g: usize, seq: &mut Seq) -> String {
    let gr = &GRAMMARS[g];
    for _ in 0..16 {
        let mut root = proper(g, seq);
        if root.len() > 7 {
            root.truncate(5);
        }
        let s = format!("{}{}", root, seq.pick(gr.suffixes));
        if !blocked(&s) {
            return s;
        }
    }
    proper(g, seq)
}

/// Name for a POI or structure. `noun` is the kind's display noun.
pub fn site_name(g: usize, noun: &str, seq: &mut Seq) -> String {
    match seq.below(3) {
        0 => format!("{} {}", proper(g, seq), noun),
        1 => format!("The {} {}", adjective(seq), noun),
        _ => format!("{} of {}", noun, proper(g, seq)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_clean_and_legal() {
        for g in 0..5 {
            let mut seq = Seq::new(99, g as u64);
            for _ in 0..500 {
                let w = world_name(g, &mut seq);
                assert!(w.len() >= 3 && w.len() <= 40, "{w}");
                assert!(w.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '\'' || c == '-'), "{w}");
                assert!(!blocked(&w));
                let s = settlement_name(g, &mut seq);
                assert!(!blocked(&s));
            }
        }
    }

    #[test]
    fn deterministic() {
        let a = world_name(2, &mut Seq::new(5, 1));
        let b = world_name(2, &mut Seq::new(5, 1));
        assert_eq!(a, b);
    }
}
