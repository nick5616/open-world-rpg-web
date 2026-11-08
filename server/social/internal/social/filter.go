package social

import (
	_ "embed"
	"strings"
	"unicode"
)

// Profanity filter (spec 10): on by default for global and zone, each player
// can switch it off for what THEY read (set_filter). It is applied on
// delivery, per recipient, so the stored text stays raw: reports must show
// moderators what was actually written.
//
// Matching is word based, after folding case and common leet substitutions,
// because substring matching is how filters end up masking "class" and
// "Scunthorpe". Three kinds of entry in filter_words.txt:
//
//	word    whole word only ("ass" masks "ass", not "assassin")
//	word*   word prefix ("shit*" masks "shitty")
//	*word*  anywhere in a word, only for roots no innocent word contains
//	!word   allow-listed exactly; wins over everything (e.g. the "Bitchin'"
//	        rarity tier from spec 2 must never be masked)
//
// Masking keeps length so the sentence still reads naturally.

//go:embed filter_words.txt
var filterWords string

type wordFilter struct {
	exact    map[string]bool
	prefix   []string
	anywhere []string
	allow    map[string]bool
}

var defaultFilter = parseFilter(filterWords)

func parseFilter(src string) *wordFilter {
	f := &wordFilter{exact: map[string]bool{}, allow: map[string]bool{}}
	for _, line := range strings.Split(src, "\n") {
		w := strings.ToLower(strings.TrimSpace(line))
		if w == "" || strings.HasPrefix(w, "#") {
			continue
		}
		switch {
		case strings.HasPrefix(w, "!"):
			f.allow[w[1:]] = true
		case strings.HasPrefix(w, "*") && strings.HasSuffix(w, "*") && len(w) > 2:
			f.anywhere = append(f.anywhere, w[1:len(w)-1])
		case strings.HasSuffix(w, "*"):
			f.prefix = append(f.prefix, w[:len(w)-1])
		default:
			f.exact[w] = true
		}
	}
	return f
}

// leet folds the substitutions people use to dodge filters.
var leet = map[rune]rune{'0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '|': 'i'}

func fold(word string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(word) {
		if m, ok := leet[r]; ok {
			r = m
		}
		if unicode.IsLetter(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// squeeze collapses runs of the same letter ("fuuuck" -> "fuck"). Checked as
// a second spelling, never instead of the folded word, because real words
// have double letters ("ass" would squeeze to "as").
func squeeze(s string) string {
	var b strings.Builder
	var last rune
	for i, r := range s {
		if i > 0 && r == last {
			continue
		}
		b.WriteRune(r)
		last = r
	}
	return b.String()
}

func (f *wordFilter) bad(word string) bool {
	w := fold(word)
	if w == "" || f.allow[w] {
		return false
	}
	for _, cand := range []string{w, squeeze(w)} {
		if f.allow[cand] {
			return false
		}
		if f.exact[cand] {
			return true
		}
		for _, p := range f.prefix {
			if strings.HasPrefix(cand, p) {
				return true
			}
		}
		for _, a := range f.anywhere {
			if strings.Contains(cand, a) {
				return true
			}
		}
	}
	return false
}

// Clean masks bad words with '*', keeping everything else byte for byte.
func (f *wordFilter) Clean(text string) string {
	// A "word" is a run of letters, digits and the leet symbols, so "sh1t"
	// stays one token but punctuation around it survives unmasked.
	isWordRune := func(r rune) bool {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return true
		}
		_, ok := leet[r]
		return ok
	}
	runes := []rune(text)
	changed := false
	for i := 0; i < len(runes); {
		if !isWordRune(runes[i]) {
			i++
			continue
		}
		j := i
		for j < len(runes) && isWordRune(runes[j]) {
			j++
		}
		// Trailing '!' is punctuation far more often than a leet 'i'.
		end := j
		for end > i && runes[end-1] == '!' {
			end--
		}
		if end > i && f.bad(string(runes[i:end])) {
			for k := i; k < end; k++ {
				runes[k] = '*'
			}
			changed = true
		}
		i = j
	}
	if !changed {
		return text
	}
	return string(runes)
}
