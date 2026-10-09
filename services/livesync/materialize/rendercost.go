// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"bufio"
	"context"
	"io"
	"maps"
	"math"
	"regexp"
	"regexp/syntax"
	"slices"
	"strings"
	"sync"
	"time"

	"forgejo.org/modules/git"
	"forgejo.org/modules/markup"
	"forgejo.org/modules/markup/markdown"
	"forgejo.org/modules/references"
	"forgejo.org/modules/regexplru"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// The writer renders the bodies of the sync log one after the other, for
// everyone (upstream renders a body on the request of whoever views it).
// So what a body costs to render is what one poster can take from every
// reader's latency, and a body is cheap to post: API v1 has no rate limit
// by default and a 64 KiB body of @mentions took 1.45 s to render (backend
// audit, round 2), one of 13 000 identical headings 17 s (round 3). Four
// bounds keep the writer's rendering in proportion:
//
//   - renderCost estimates a body's rendering time from the markup
//     features that look something up and the constructs whose rendering
//     grows faster than the body, before rendering it; a body over
//     maxRenderCost is not rendered by the writer (or a snapshot) at all:
//     it is sent with body_truncated, and a client that shows it gets its
//     HTML from GET /-/sync/api/bodies, rendered on that request.
//   - the writer waits for a rendering for at most renderWait
//     (loader.renderBounded): the estimate cannot know every slow input of
//     goldmark and the post-processors, and their CPU work cannot be
//     interrupted, so a rendering that takes longer is abandoned to its
//     goroutine (body_truncated); at most maxAbandonedRenders of those
//     run at a time, and while they do the writer renders nothing. The
//     estimate is part of the rendering job, so the wait bounds it too:
//     with an external tracker's regexp style it runs the repository
//     owner's own pattern, whose cost no one bounds (backend audit, round
//     4: 13 s for a 111-byte pattern over 64 KiB). Nothing whose cost
//     depends on the body or on the repository's settings runs on the
//     writer's goroutine before that bound applies; loader.render only
//     compares the body's length with maxRenderCost.
//   - prefillCommits answers the commit SHA lookups of a rendering with
//     one git process instead of one per missing SHA.
//   - renderShare bounds the share of the writer's time that rendering
//     takes, overall and per repository: once a share is used up, bodies
//     are sent with body_truncated until it is replenished, instead of the
//     sync log falling behind.

// Per-token costs of renderCost, measured with the markup service on
// SQLite (B-audit round 2; PostgreSQL and MySQL lookups are slower, which
// the margin of maxRenderCost absorbs).
const (
	// costPerByte: goldmark and the text processors.
	costPerByte = 500 * time.Nanosecond
	// costPerMention: services/markup's IsUsernameMentionable looks up
	// every @mention (each occurrence) in the database.
	costPerMention = 150 * time.Microsecond
	// costPerCommit: a distinct SHA-like word, answered by prefillCommits.
	costPerCommit = 70 * time.Microsecond
	// costPerRef: an issue reference (#1, !1) becomes a link.
	costPerRef = 10 * time.Microsecond
	// costPerPreview: a permalink of a file of this instance: the
	// preview reads the repository, the permission and the blob (the box
	// is then dropped, see stripFilePreviews).
	costPerPreview = 15 * time.Millisecond
	// costPerCrossRefSquared: owner/repo#1 references in one text node are
	// quadratic (1 000 on one line: 360 ms, 3 000: 3.6 s, and renderTimeout
	// does not interrupt it); the square of the body's count is a bound.
	costPerCrossRefSquared = 400 * time.Nanosecond

	// The constructs below (backend audit, round 3) are counted by
	// structureCost; each was measured with 64 KiB bodies made of it.

	// costPerIDSquared: every heading (and footnote) gets an id, and the
	// ids of identical headings are found by trying -1, -2, … in turn
	// (modules/markup/markdown prefixedIDs): 16 000 empty headings took
	// 43 s. Which headings share an id is not known from the source (the
	// id is made of the rendered text), so the square of their count is
	// the bound.
	costPerIDSquared = 170 * time.Nanosecond
	// costPerNestingSquared: block quote and list markers opened on one
	// line ("- - - …": 32 000 took 2.6 s), per line.
	costPerNestingSquared = 3 * time.Nanosecond
	// costPerTableCell: a table row has as many cells as its header (the
	// missing ones are added): 1 000 columns and 30 000 rows of "|" took
	// 31 s.
	costPerTableCell = time.Microsecond
	// costPerFence: a fenced code block is highlighted (5 000 blocks of
	// one line: 0.5 s, about 50 µs per fence line).
	costPerFence = 50 * time.Microsecond
	// costPerDelimiterSquared: emphasis delimiters ('*', '_') of one
	// paragraph that do not pair up ("a**b" + "c* " x 21 000: 3.4 s).
	costPerDelimiterSquared = 8 * time.Nanosecond
	// costPerBracketSquared: link openers of one paragraph that do not
	// close ("[a](b" x 13 000: 1 s).
	costPerBracketSquared = 6 * time.Nanosecond
	// costPerTrackerScan: with an external tracker's alphanumeric or
	// regexp issue style, issueIndexPatternProcessor looks for the first
	// numeric and the first external reference in the rest of the text
	// node before each reference it links, and these regular expressions
	// (with submatches) run at about 100 ns per byte: references x bytes
	// of the text node ("ABC-1 " x 10 900: 43 s; "!1 " x 20 000 then one
	// "ABC-1": 103 s).
	costPerTrackerScan = 100 * time.Nanosecond
	// costPerRegexpInst and costPerRegexpCap: with the regexp style, the
	// pattern is the repository owner's, and the processor's search
	// (FindStringSubmatchIndex) takes up to about 11 ns per byte of input
	// and instruction of the compiled program (measured with programs of
	// 7 to 20 000 instructions; a 12-byte pattern such as `(\w{1,999}Z)`
	// compiles to 2 000 instructions, one of 1 300 bytes to 200 000), plus
	// up to about 0.4 ns per byte, instruction and capture slot: Go's NFA
	// copies a thread's 2 × (groups + 1) submatch positions whenever it
	// adds one, so a pattern of many groups costs about the square of its
	// size (backend audit, round 4 bis: `(\w?)` × 3 000 + "Z", 12 003
	// instructions and 6 002 slots, took 16.5 s over 1 110 bytes). The
	// rate of a search is the program's instructions × (costPerRegexpInst
	// + slots × costPerRegexpCap), at least costPerTrackerScan per byte.
	costPerRegexpInst = 15 * time.Nanosecond
	costPerRegexpCap  = time.Nanosecond
	// maxRegexpWork bounds instructions × capture slots of a pattern the
	// writer runs at all: the NFA keeps up to a thread per instruction,
	// each with its own slots (`(\w?)` × 3 000 + "Z" allocated 282 MB for
	// a search over 64 bytes, × 10 000 would need about 1.6 GB), so a body
	// in a repository with a larger pattern is over the limit whatever its
	// length. Ordinary patterns are under a few hundred (`(T\d+)`: 7 × 4);
	// `(\w{1,999}Z)` is 2 002 × 4.
	maxRegexpWork = 1 << 18
)

// maxRenderCost is the most a body may be estimated to cost for the writer
// to render it. Ordinary bodies cost a few milliseconds; it takes about
// 1 600 mentions, 16 file permalinks, 800 cross-repository references,
// 3 500 SHA-like words, 1 200 headings, 5 000 fenced code blocks or 250 000
// table cells to exceed it; 64 KiB of plain text costs 33 ms, 64 KiB of #1
// references 240 ms. A variable so that tests can change it.
var maxRenderCost = 250 * time.Millisecond

var (
	// commitCandidate is a superset of what modules/markup's
	// hashCurrentPattern checks with git: a run of 7 to 64 lowercase hex
	// digits between non-word characters.
	commitCandidate = regexp.MustCompile(`\b[0-9a-f]{7,64}\b`)
	// issueRef is a superset of references' issue references.
	issueRef = regexp.MustCompile(`[#!][0-9]+`)
	// crossRef is a superset of references' cross-repository issue
	// reference (owner/repo#1, owner/repo!1).
	crossRef = regexp.MustCompile(`[0-9A-Za-z_.-]+/[0-9A-Za-z_.-]+[#!][0-9]+`)
	// alphanumericRef is a superset of references' alphanumeric issue
	// reference (ABC-123).
	alphanumericRef = regexp.MustCompile(`[A-Z]{1,10}-[1-9][0-9]*`)
)

// renderCost estimates the time renderMarkdown takes to render content
// with the markup metas of its repository (see the cost constants; metas
// may be nil). Over-estimates are safe: such a body is only rendered on
// request instead of by the writer. It stops counting once the estimate
// exceeds maxRenderCost (the result is then over it) or ctx is done.
//
// It runs on the rendering's goroutine (renderJob.run), never on the
// writer's: its work grows with the body, and with the regexp tracker
// style it runs the repository owner's pattern.
func renderCost(ctx context.Context, content string, metas map[string]string) time.Duration {
	cost := time.Duration(len(content)) * costPerByte
	if cost > maxRenderCost {
		return cost
	}
	cost += time.Duration(len(references.FindAllMentionsBytes([]byte(content)))) * costPerMention
	cost += time.Duration(len(commitCandidates(content))) * costPerCommit
	// modules/markup's filePreviewPattern: https?://…/src/commit/{sha}/{path}#L…
	cost += time.Duration(strings.Count(content, "/src/commit/")) * costPerPreview
	cost += time.Duration(len(issueRef.FindAllStringIndex(content, -1))) * costPerRef
	refs := time.Duration(len(crossRef.FindAllStringIndex(content, -1)))
	cost += refs * refs * costPerCrossRefSquared
	if cost > maxRenderCost {
		return cost
	}
	cost += structureCost(content)
	if cost > maxRenderCost {
		return cost
	}
	return cost + trackerCost(ctx, content, metas, maxRenderCost-cost)
}

// structureCost is the part of renderCost for the constructs of goldmark
// whose rendering grows faster than the body (round 3 of the backend
// audit; the cost constants from costPerIDSquared to
// costPerBracketSquared). It reads the source line by line, with a coarse
// idea of markdown's blocks that errs on the side of counting more: a
// line's leading block quote and list markers, headings (ATX, and any
// line of only '=' or '-' as a setext underline), table delimiter rows,
// fences; paragraphs end at blank lines.
func structureCost(content string) time.Duration {
	var (
		ids, fences, lines, maxPipes int
		table                        bool
		nesting, inline              int64
		// The emphasis delimiters and link openers of the paragraph so far.
		delims, brackets int64
	)
	endParagraph := func() {
		inline += delims*delims*int64(costPerDelimiterSquared) + brackets*brackets*int64(costPerBracketSquared)
		delims, brackets = 0, 0
	}
	for start := 0; start < len(content); {
		end := strings.IndexByte(content[start:], '\n')
		if end < 0 {
			end = len(content)
		} else {
			end += start
		}
		line := strings.TrimSuffix(content[start:end], "\r")
		lines++
		start = end + 1
		if strings.TrimSpace(line) == "" {
			endParagraph()
			continue
		}
		depth, rest := containerMarkers(line)
		nesting += int64(depth) * int64(depth)
		if isATXHeading(rest) || isUnderline(rest) || isUnderline(strings.TrimLeft(line, " \t>")) {
			ids++
		}
		if strings.HasPrefix(rest, "```") || strings.HasPrefix(rest, "~~~") {
			fences++
		}
		pipes := strings.Count(line, "|")
		maxPipes = max(maxPipes, pipes)
		if !table && isDelimiterRow(rest) {
			table = true
		}
		delims += int64(strings.Count(line, "*") + strings.Count(line, "_"))
		brackets += int64(strings.Count(line, "["))
	}
	endParagraph()
	ids += strings.Count(content, "[^") // footnotes take ids from the same set
	cost := time.Duration(ids) * time.Duration(ids) * costPerIDSquared
	cost += time.Duration(nesting) * costPerNestingSquared
	cost += time.Duration(fences) * costPerFence
	cost += time.Duration(inline)
	if table {
		cost += time.Duration(maxPipes+1) * time.Duration(lines) * costPerTableCell
	}
	return cost
}

// trackerCost is the part of renderCost for issueIndexPatternProcessor
// with an external tracker's alphanumeric or regexp issue style (see
// trackerScan); it is 0 for the other styles. It charges the searches on
// the text nodes that the processor is given (textNodes): what is one
// text node is decided by goldmark's HTML and by how the HTML parser reads
// it, not by the source's lines. A <textarea>, <style>, <script>, <title>,
// <xmp> or <plaintext> element, a <select>, a CDATA section in <svg>, a
// raw HTML block of lines without a blank one, … make one text node of
// everything up to their end, the markup goldmark renders for the
// markdown in between included (backend audit, round 4 ter: 8 000 lines of
// "ABC-1" in a <textarea> were estimated as 8 000 nodes, 48 ms, and took
// 23 s). So the estimate renders the body with goldmark and parses it as
// the post-processor does; that costs about what goldmark takes in the
// rendering (part of costPerByte), and only for bodies of a repository
// with such a style.
func trackerCost(ctx context.Context, content string, metas map[string]string, budget time.Duration) time.Duration {
	s := newTrackerScan(ctx, metas, budget)
	if s.re == nil {
		return 0
	}
	if s.rate == unrunnable {
		return budget + 1
	}
	textNodes(ctx, content, metas, func(text string) bool {
		s.segment(text)
		return s.cost <= s.budget && ctx.Err() == nil
	})
	return s.cost
}

// postProcessTagCleaner is modules/markup's tagCleaner, which
// postProcess applies to goldmark's HTML before parsing it.
var postProcessTagCleaner = regexp.MustCompile(`<((?:/?\w+/\w+)|(?:/[\w ]+/)|(/?[hH][tT][mM][lL]\b)|(/?[hH][eE][aA][dD]\b))`)

// textNodes renders content with goldmark (markdown.Renderer, the first
// stage of markdown.RenderString), parses the HTML as modules/markup's
// postProcess does, and calls visit with the text of each text node that
// postProcess gives the processors, in document order, until visit
// returns false. Like visitNode it skips <code>, <pre> and <a> elements
// (whose text gets only the emoji processors) and emoji; the processors
// that run before issueIndexPatternProcessor only split a text node.
// Goldmark's output when it fails or panics is what the post-processor
// reads too (its partial output, or the source).
func textNodes(ctx context.Context, content string, metas map[string]string, visit func(string) bool) {
	rc := &markup.RenderContext{Ctx: ctx, Metas: maps.Clone(metas)}
	var raw strings.Builder
	_ = markdown.Renderer{}.Render(rc, strings.NewReader(content), &raw)
	cleaned := postProcessTagCleaner.ReplaceAllString(strings.ReplaceAll(raw.String(), "\x00", ""), "&lt;$1")
	doc, err := html.Parse(strings.NewReader("<html><body>" + cleaned + "</body></html>"))
	if err != nil {
		// postProcess renders nothing then; charge the HTML as one node.
		visit(cleaned)
		return
	}
	var walk func(n *html.Node) bool
	walk = func(n *html.Node) bool {
		switch n.Type {
		case html.TextNode:
			return visit(n.Data)
		case html.ElementNode:
			switch n.DataAtom {
			case atom.Code, atom.Pre, atom.A:
				return true
			}
			for _, a := range n.Attr {
				if a.Key == "class" && a.Val == "emoji" {
					return true
				}
			}
		case html.DocumentNode:
		default:
			return true
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if !walk(c) {
				return false
			}
		}
		return true
	}
	walk(doc)
}

// trackerScan estimates what issueIndexPatternProcessor costs with an
// external tracker's alphanumeric or regexp issue style (see
// costPerTrackerScan): on each text node it searches the rest of the node
// for the first external and the first numeric reference before each
// reference it links, and once more; each search costs up to the length
// of the rest of the node times the pattern's rate. The estimate charges
// every search before running it (so it charges at least one search over
// all text, which the processor runs even when nothing matches), and it
// runs no search once the charges exceed its budget: the pattern may be
// the repository owner's, and whatever it costs, the estimate costs no
// more than about what the processor was allowed.
type trackerScan struct {
	ctx    context.Context
	re     *regexp.Regexp // nil: no tracker style, nothing to charge
	rate   time.Duration  // per byte of one search; unrunnable: never run
	budget time.Duration
	cost   time.Duration
}

// unrunnable is the rate of a pattern the writer never runs: any search
// costs more than any budget.
const unrunnable = time.Duration(math.MaxInt64)

func newTrackerScan(ctx context.Context, metas map[string]string, budget time.Duration) *trackerScan {
	s := &trackerScan{ctx: ctx, budget: budget}
	switch metas["style"] {
	case markup.IssueNameStyleAlphanumeric:
		s.re, s.rate = alphanumericRef, costPerTrackerScan
	case markup.IssueNameStyleRegexp:
		// As the processor compiles it (cached by both).
		pattern, err := regexplru.GetCompiled(metas["regexp"])
		if err != nil {
			return s // the processor links nothing then
		}
		s.re = pattern
		size := regexpSize(metas["regexp"])
		switch {
		case size.empty, size.insts*size.slots > maxRegexpWork:
			// See endlessTracker and maxRegexpWork.
			s.rate = unrunnable
		default:
			s.rate = max(costPerTrackerScan, time.Duration(size.insts)*(costPerRegexpInst+time.Duration(size.slots)*costPerRegexpCap))
		}
	}
	return s
}

// endlessTracker says whether metas have the regexp issue style with a
// pattern that may match the empty string. issueIndexPatternProcessor
// then never ends on a text node where it matches empty before the end
// (see trackerScan.segment), and it allocates a link node on each turn,
// so that the rendering takes a core and the memory until the process
// ends (backend audit, round 4 ter: 250 MB/s with `(x*)`). No such
// pattern links anything useful; renderJob.run does not render with one,
// on request (GET /-/sync/api/bodies, previews) either, where upstream
// would.
func endlessTracker(metas map[string]string) bool {
	return metas["style"] == markup.IssueNameStyleRegexp && regexpSize(metas["regexp"]).empty
}

// segment charges the processor's searches on one text node. It follows
// the processor: after a match the search goes on with the text after it.
// A match that is empty and not at the end of the text leaves that text
// as it was (replaceContent inserts the link and then the whole rest
// again, and the processor goes on with that rest): the processor's loop
// never ends there, inserting a link node on each turn (backend audit,
// round 4 ter: `(x*)` over "abc"), so the estimate is saturated. (A
// pattern that may match the empty string is not run at all, see
// newTrackerScan; this follows the processor on the text it is given.)
func (s *trackerScan) segment(text string) {
	if s.re == nil || text == "" {
		return
	}
	found := false
	for pos := 0; pos < len(text); {
		// A search steps through every position of the rest of the text,
		// its end included.
		if !s.charge(len(text) - pos + 1) {
			return
		}
		// The processor's search finds the same match with submatches,
		// whose cost the rate charges.
		loc := s.re.FindStringIndex(text[pos:])
		if loc == nil {
			break
		}
		found = true
		if loc[0] == loc[1] {
			if pos+loc[1] < len(text) {
				s.cost = s.budget + 1
				return
			}
			break // the link goes at the end, the processor stops
		}
		pos += loc[1]
	}
	if found {
		// A numeric reference before an external one is linked first.
		s.charge(len(issueRef.FindAllStringIndex(text, -1)) * len(text))
	}
}

// charge adds a search of n bytes; it says whether the estimate is still
// within its budget (and the rendering not abandoned).
func (s *trackerScan) charge(n int) bool {
	if s.cost > s.budget || s.ctx.Err() != nil {
		return false
	}
	if time.Duration(n) > (s.budget-s.cost)/s.rate {
		s.cost = s.budget + 1 // saturated: n × rate may overflow
		return false
	}
	s.cost += time.Duration(n) * s.rate
	return true
}

// regexpSizes caches regexpSize per pattern (bounded: emptied when full).
var regexpSizes = struct {
	sync.Mutex
	m map[string]regexpInfo
}{m: map[string]regexpInfo{}}

const maxRegexpSizes = 64

// regexpInfo is what regexpSize tells of a pattern.
type regexpInfo struct {
	// insts is the number of instructions of its program, slots the
	// number of capture slots of its submatch searches (2 × (groups +
	// 1)): the time and memory a search takes are proportional to them.
	insts, slots int
	// empty: the pattern may match the empty string somewhere.
	empty bool
}

// regexpSize returns what regexp.Compile makes of pattern (a valid
// pattern; it parses and compiles it the same way), which regexp.Regexp
// does not tell.
func regexpSize(pattern string) regexpInfo {
	regexpSizes.Lock()
	n, ok := regexpSizes.m[pattern]
	regexpSizes.Unlock()
	if ok {
		return n
	}
	if re, err := syntax.Parse(pattern, syntax.Perl); err == nil {
		re = re.Simplify()
		if prog, err := syntax.Compile(re); err == nil {
			n = regexpInfo{insts: len(prog.Inst), slots: prog.NumCap, empty: matchesEmpty(re)}
		}
	}
	regexpSizes.Lock()
	if len(regexpSizes.m) >= maxRegexpSizes {
		clear(regexpSizes.m)
	}
	regexpSizes.m[pattern] = n
	regexpSizes.Unlock()
	return n
}

// matchesEmpty says whether re may match the empty string at some
// position of some text: whether it matches it when every assertion (^,
// $, \A, \z, \b, \B) holds.
func matchesEmpty(re *syntax.Regexp) bool {
	switch re.Op {
	case syntax.OpEmptyMatch, syntax.OpBeginLine, syntax.OpEndLine, syntax.OpBeginText, syntax.OpEndText,
		syntax.OpWordBoundary, syntax.OpNoWordBoundary, syntax.OpStar, syntax.OpQuest:
		return true
	case syntax.OpLiteral:
		return len(re.Rune) == 0
	case syntax.OpCapture, syntax.OpPlus:
		return matchesEmpty(re.Sub[0])
	case syntax.OpRepeat:
		return re.Min == 0 || matchesEmpty(re.Sub[0])
	case syntax.OpConcat:
		return !slices.ContainsFunc(re.Sub, func(sub *syntax.Regexp) bool { return !matchesEmpty(sub) })
	case syntax.OpAlternate:
		return slices.ContainsFunc(re.Sub, matchesEmpty)
	default: // OpNoMatch, OpCharClass, OpAnyCharNotNL, OpAnyChar
		return false
	}
}

// containerMarkers returns how many block quote ('>') and list item ("-",
// "*", "+", "1.", "1)") markers line starts with, and the rest of it.
func containerMarkers(line string) (int, string) {
	depth := 0
	for {
		line = strings.TrimLeft(line, " \t")
		switch {
		case line == "":
			return depth, line
		case line[0] == '>':
			line = line[1:]
		case strings.IndexByte("-*+", line[0]) >= 0 && markerEnd(line, 1):
			line = line[1:]
		default:
			n := 0
			for n < len(line) && n < 9 && line[n] >= '0' && line[n] <= '9' {
				n++
			}
			if n == 0 || n == len(line) || (line[n] != '.' && line[n] != ')') || !markerEnd(line, n+1) {
				return depth, line
			}
			line = line[n+1:]
		}
		depth++
	}
}

// markerEnd says whether a list marker ending at i of line is followed by
// a space, a tab or the end of the line.
func markerEnd(line string, i int) bool {
	return i == len(line) || line[i] == ' ' || line[i] == '\t'
}

func isATXHeading(s string) bool {
	n := 0
	for n < len(s) && s[n] == '#' {
		n++
	}
	return n >= 1 && n <= 6 && markerEnd(s, n)
}

// isUnderline says whether s is made of '=' or of '-' only (and spaces at
// the end): a setext heading's underline (or a thematic break).
func isUnderline(s string) bool {
	s = strings.TrimRight(s, " \t\r")
	return s != "" && (strings.Trim(s, "=") == "" || strings.Trim(s, "-") == "")
}

// isDelimiterRow says whether s may be a table's delimiter row: only '-',
// ':', '|' and blanks, with a '-' and a '|' or ':'.
func isDelimiterRow(s string) bool {
	s = strings.TrimSpace(s)
	return strings.Trim(s, "-:| \t") == "" && strings.Contains(s, "-") && strings.ContainsAny(s, "|:")
}

// commitCandidates returns the distinct SHA-like words of content.
func commitCandidates(content string) []string {
	var res []string
	seen := map[string]bool{}
	for _, m := range commitCandidate.FindAllString(content, -1) {
		if !seen[m] {
			seen[m] = true
			res = append(res, m)
		}
	}
	return res
}

// prefillCommits fills known (the RenderContext's ShaExistCache) with
// whether each SHA-like word of content names an object of gitRepo, all
// through the repository's one `git cat-file --batch-check` process.
// modules/markup's hashCurrentPatternProcessor looks up every word it does
// not find in that cache with git.Repository.IsReferenceExist, whose error
// on a missing object discards the process: one new git process per
// missing SHA (4 ms each; 64 KiB of them took over a minute). The answers
// are the same (the object name as cat-file resolves it). Words it misses
// are left to the processor; it stops early when ctx is done.
func prefillCommits(ctx context.Context, gitRepo *git.Repository, content string, known map[string]bool) {
	var todo []string
	for _, c := range commitCandidates(content) {
		if _, ok := known[c]; !ok {
			todo = append(todo, c)
		}
	}
	if len(todo) == 0 {
		return
	}
	// The process belongs to the repository (it is reused after this
	// rendering): it runs with the repository's context, as in
	// IsReferenceExist, not with the rendering's deadline.
	_ = gitRepo.WithCatFileBatchCheck(gitRepo.Ctx, func(wr io.Writer, rd *bufio.Reader) error {
		for _, name := range todo {
			if ctx.Err() != nil {
				return nil
			}
			if _, err := wr.Write([]byte(name + "\n")); err != nil {
				return err
			}
			_, _, _, err := git.ReadBatchLine(rd)
			if err != nil && !git.IsErrNotExist(err) {
				return err // the pipe is in an unknown state: the process is discarded
			}
			known[name] = err == nil
		}
		return nil
	})
}

// renderShare bounds the time the writer spends rendering (see the top of
// this file) with token buckets of render time that fill with wall time:
// one for all rendering and one per repository, so that one repository's
// bodies cannot use up everyone's share. A rendering is allowed while both
// of its buckets hold time; what the writer waited for it is then taken
// from both (they may go below zero by one wait, which renderWait bounds),
// and what an abandoned rendering took beyond that from the repository's
// bucket when it ends (chargeRepo). Safe for concurrent use.
type renderShare struct {
	mu    sync.Mutex
	now   func() time.Time
	all   renderBucket
	repos map[int64]*renderBucket
}

// The shares: rendering takes at most a quarter of the writer's time over
// time, and the bodies of one repository a tenth, with bursts of 20 s and
// 10 s of rendering (a migration of a few thousand comments).
const (
	shareAll       = 0.25
	shareAllBurst  = 20 * time.Second
	shareRepo      = 0.1
	shareRepoBurst = 10 * time.Second
	// maxShareRepos bounds the per-repository buckets kept; full ones
	// (equal to a new bucket) are dropped first.
	maxShareRepos = 1000
)

type renderBucket struct {
	level time.Duration // render time available
	at    time.Time     // when level was computed
}

func (b *renderBucket) fill(now time.Time, share float64, burst time.Duration) {
	if elapsed := now.Sub(b.at); elapsed > 0 {
		b.level = min(burst, b.level+time.Duration(float64(elapsed)*share))
	}
	b.at = now
}

func newRenderShare() *renderShare {
	return &renderShare{
		now:   time.Now,
		all:   renderBucket{level: shareAllBurst, at: time.Now()},
		repos: map[int64]*renderBucket{},
	}
}

// allow says whether a body of repository repo may be rendered now.
func (s *renderShare) allow(repo int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.all.fill(now, shareAll, shareAllBurst)
	b := s.repo(repo, now)
	b.fill(now, shareRepo, shareRepoBurst)
	return s.all.level > 0 && b.level > 0
}

// charge takes the time a rendering of repository repo took from its
// buckets.
func (s *renderShare) charge(repo int64, took time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.all.fill(now, shareAll, shareAllBurst)
	s.all.level -= took
	b := s.repo(repo, now)
	b.fill(now, shareRepo, shareRepoBurst)
	b.level -= took
}

// chargeRepo takes took from repository repo's bucket only: the time an
// abandoned rendering ran after the writer stopped waiting for it, which
// was not the writer's time but was spent on the repository's body.
func (s *renderShare) chargeRepo(repo int64, took time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	b := s.repo(repo, now)
	b.fill(now, shareRepo, shareRepoBurst)
	b.level -= took
}

func (s *renderShare) repo(id int64, now time.Time) *renderBucket {
	if b, ok := s.repos[id]; ok {
		return b
	}
	if len(s.repos) >= maxShareRepos {
		for k, b := range s.repos {
			if b.fill(now, shareRepo, shareRepoBurst); b.level >= shareRepoBurst {
				delete(s.repos, k)
			}
		}
	}
	b := &renderBucket{level: shareRepoBurst, at: now}
	s.repos[id] = b
	return b
}
