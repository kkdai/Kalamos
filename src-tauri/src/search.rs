//! #73 B: search the Markdown files of a folder.
//!
//! - Only Markdown extensions (`open_with::MARKDOWN_EXTENSIONS`).
//! - Hidden entries and `node_modules` are skipped, so are files over 5 MB.
//! - The root is canonicalized and symlinks are never followed, so the walk
//!   cannot leave the root. Result paths keep the root as the caller spelled
//!   it, so they match the paths of the file tree.
//! - At most `MAX_RESULTS` hits; `truncated` says there were more.
//! - `line` is 1-based; `column` is 1-based in UTF-16 code units and `length`
//!   is in UTF-16 code units, so the front end can map them to CodeMirror
//!   positions directly. Snippets are cut on char boundaries (never inside a
//!   multi-byte character).

use std::fs;
use std::path::{Path, PathBuf};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorKind};
use crate::open_with::has_markdown_extension;
use crate::tree::is_ignored_name;

pub const MAX_RESULTS: usize = 1000;
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Longest snippet, in chars (ellipses not counted).
pub const SNIPPET_MAX_CHARS: usize = 160;
/// Chars of context kept before the hit when the line is cut.
pub const SNIPPET_CONTEXT_CHARS: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub length: usize,
    pub snippet: String,
    /// The hit inside `snippet`, in UTF-16 code units.
    pub snippet_match_start: usize,
    pub snippet_match_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
    pub files_searched: usize,
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whole word: no word character continues the hit on either side.
fn is_whole_word(line: &str, start: usize, end: usize) -> bool {
    let before = line[..start].chars().next_back();
    let first = line[start..end].chars().next();
    let last = line[start..end].chars().next_back();
    let after = line[end..].chars().next();
    let left_ok = !matches!((before, first), (Some(b), Some(f)) if is_word_char(b) && is_word_char(f));
    let right_ok = !matches!((last, after), (Some(l), Some(a)) if is_word_char(l) && is_word_char(a));
    left_ok && right_ok
}

pub fn build_matcher(query: &str, case_sensitive: bool, regex: bool) -> Result<Regex, AppError> {
    let pattern = if regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| AppError::parse(format!("Invalid regular expression: {e}")))
}

/// The snippet for the hit at bytes `start..end` of `line`, plus the hit's
/// position inside it (UTF-16 code units).
pub fn make_snippet(line: &str, start: usize, end: usize) -> (String, usize, usize) {
    let chars: Vec<char> = line.chars().collect();
    let total = chars.len();
    let hit_from = line[..start].chars().count();
    let hit_to = hit_from + line[start..end].chars().count();

    let mut from = if total <= SNIPPET_MAX_CHARS {
        0
    } else {
        hit_from.saturating_sub(SNIPPET_CONTEXT_CHARS)
    };
    let mut to = (from + SNIPPET_MAX_CHARS).min(total);
    if to - from < SNIPPET_MAX_CHARS {
        from = to.saturating_sub(SNIPPET_MAX_CHARS);
    }
    // Leading indentation is noise in a result list.
    while from < hit_from && chars[from].is_whitespace() {
        from += 1;
    }
    while to > hit_to && to > from && chars[to - 1].is_whitespace() {
        to -= 1;
    }

    let mut snippet = String::new();
    // Only cut text (not trimmed whitespace) earns an ellipsis.
    if chars[..from].iter().any(|c| !c.is_whitespace()) {
        snippet.push('…');
    }
    let prefix_len = utf16_len(&snippet);
    // from <= hit_from <= to always holds (at most 40 chars of context before).
    let hit_end = hit_to.min(to);
    let before: String = chars[from..hit_from].iter().collect();
    let hit: String = chars[hit_from..hit_end].iter().collect();
    let after: String = chars[hit_end..to].iter().collect();
    let match_start = prefix_len + utf16_len(&before);
    let match_end = match_start + utf16_len(&hit);
    snippet.push_str(&before);
    snippet.push_str(&hit);
    snippet.push_str(&after);
    if chars[to..].iter().any(|c| !c.is_whitespace()) {
        snippet.push('…');
    }
    (snippet, match_start, match_end)
}

struct Walk<'a> {
    matcher: &'a Regex,
    whole_word: bool,
    canonical_root: &'a Path,
    display_root: &'a Path,
    hits: Vec<SearchHit>,
    truncated: bool,
    files_searched: usize,
}

impl Walk<'_> {
    fn done(&self) -> bool {
        self.truncated
    }

    fn walk_dir(&mut self, dir: &Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        let mut files = Vec::new();
        let mut dirs = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if is_ignored_name(name) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Never follow symlinks: the walk must not leave the root.
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                dirs.push(path);
            } else if file_type.is_file() && has_markdown_extension(&path) {
                files.push(path);
            }
        }
        for file in files {
            if self.done() {
                return;
            }
            self.search_file(&file);
        }
        for sub in dirs {
            if self.done() {
                return;
            }
            self.walk_dir(&sub);
        }
    }

    fn display_path(&self, path: &Path) -> String {
        match path.strip_prefix(self.canonical_root) {
            Ok(rel) => self.display_root.join(rel),
            Err(_) => PathBuf::from(path),
        }
        .to_string_lossy()
        .into_owned()
    }

    fn search_file(&mut self, path: &Path) {
        let Ok(meta) = fs::metadata(path) else {
            return;
        };
        if meta.len() > MAX_FILE_BYTES {
            return;
        }
        let Ok(bytes) = fs::read(path) else {
            return;
        };
        self.files_searched += 1;
        let text = String::from_utf8_lossy(&bytes);
        let display = self.display_path(path);
        for (idx, raw_line) in text.split('\n').enumerate() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            for m in self.matcher.find_iter(line) {
                if m.start() == m.end() {
                    continue;
                }
                if self.whole_word && !is_whole_word(line, m.start(), m.end()) {
                    continue;
                }
                if self.hits.len() >= MAX_RESULTS {
                    self.truncated = true;
                    return;
                }
                let (snippet, snippet_match_start, snippet_match_end) =
                    make_snippet(line, m.start(), m.end());
                self.hits.push(SearchHit {
                    path: display.clone(),
                    line: idx + 1,
                    column: utf16_len(&line[..m.start()]) + 1,
                    length: utf16_len(m.as_str()),
                    snippet,
                    snippet_match_start,
                    snippet_match_end,
                });
            }
        }
    }
}

pub fn search_in_folder_impl(
    root: &str,
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
) -> Result<SearchResults, AppError> {
    if root.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let canonical_root = crate::platform::canonicalize(root)
        .map_err(|_| AppError::not_found(format!("Directory does not exist: {root}")))?;
    if !canonical_root.is_dir() {
        return Err(AppError::invalid_path(format!("Path is not a directory: {root}")));
    }
    if query.is_empty() {
        return Ok(SearchResults {
            hits: Vec::new(),
            truncated: false,
            files_searched: 0,
        });
    }
    let matcher = build_matcher(query, case_sensitive, regex)?;
    let mut walk = Walk {
        matcher: &matcher,
        whole_word,
        canonical_root: &canonical_root,
        display_root: Path::new(root),
        hits: Vec::new(),
        truncated: false,
        files_searched: 0,
    };
    walk.walk_dir(&canonical_root);
    Ok(SearchResults {
        hits: walk.hits,
        truncated: walk.truncated,
        files_searched: walk.files_searched,
    })
}

/// Runs off the main thread so a large folder never blocks the UI.
#[tauri::command]
pub async fn search_in_folder(
    root: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
) -> Result<SearchResults, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        search_in_folder_impl(&root, &query, case_sensitive, whole_word, regex)
    })
    .await
    .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn search(root: &Path, q: &str, case: bool, word: bool, re: bool) -> SearchResults {
        search_in_folder_impl(root.to_str().unwrap(), q, case, word, re).expect("search")
    }

    #[test]
    fn case_sensitivity_and_positions() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "Apple apple\n第二行 APPLE\r\nend").unwrap();
        let all = search(dir.path(), "apple", false, false, false);
        assert_eq!(all.hits.len(), 3);
        assert_eq!(all.files_searched, 1);
        assert_eq!((all.hits[0].line, all.hits[0].column, all.hits[0].length), (1, 1, 5));
        assert_eq!((all.hits[1].line, all.hits[1].column), (1, 7));
        // "第二行 " is 4 UTF-16 units.
        assert_eq!((all.hits[2].line, all.hits[2].column), (2, 5));
        assert_eq!(all.hits[2].snippet, "第二行 APPLE");

        let exact = search(dir.path(), "apple", true, false, false);
        assert_eq!(exact.hits.len(), 1);
        assert_eq!(exact.hits[0].column, 7);
    }

    #[test]
    fn whole_word_and_literal_special_chars() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "cat concat cat_x (cat) a.b axb").unwrap();
        let words = search(dir.path(), "cat", false, true, false);
        assert_eq!(words.hits.iter().map(|h| h.column).collect::<Vec<_>>(), vec![1, 19]);
        // Not a regex: "." is literal.
        let lit = search(dir.path(), "a.b", false, false, false);
        assert_eq!(lit.hits.len(), 1);
        let re = search(dir.path(), "a.b", false, false, true);
        assert_eq!(re.hits.len(), 2);
    }

    #[test]
    fn regex_and_invalid_regex() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "foo-1 foo-22 bar-3").unwrap();
        let r = search(dir.path(), r"foo-(\d+)", true, false, true);
        assert_eq!(r.hits.iter().map(|h| h.length).collect::<Vec<_>>(), vec![5, 6]);
        // Empty matches are skipped.
        assert!(search(dir.path(), "x*", true, false, true).hits.is_empty());
        let err = search_in_folder_impl(dir.path().to_str().unwrap(), "foo(", true, false, true)
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Parse);
    }

    #[test]
    fn utf8_snippets_are_cut_on_char_boundaries() {
        let dir = tempdir().unwrap();
        let line = format!("{}關鍵字{}", "蘆葦筆".repeat(40), "莎草紙🙂".repeat(60));
        fs::write(dir.path().join("a.md"), &line).unwrap();
        let r = search(dir.path(), "關鍵字", false, false, false);
        assert_eq!(r.hits.len(), 1);
        let h = &r.hits[0];
        assert!(h.snippet.starts_with('…'));
        assert!(h.snippet.ends_with('…'));
        assert!(h.snippet.chars().count() <= SNIPPET_MAX_CHARS + 2);
        let units: Vec<u16> = h.snippet.encode_utf16().collect();
        let hit = String::from_utf16(&units[h.snippet_match_start..h.snippet_match_end]).unwrap();
        assert_eq!(hit, "關鍵字");
        assert_eq!(h.column, 121);

        // Emoji before the hit count as two UTF-16 units.
        fs::write(dir.path().join("a.md"), "🙂 hit").unwrap();
        let e = search(dir.path(), "hit", false, false, false);
        assert_eq!(e.hits[0].column, 4);
        assert_eq!((e.hits[0].snippet_match_start, e.hits[0].snippet_match_end), (3, 6));
    }

    #[test]
    fn snippet_trims_indentation_and_keeps_short_lines_whole() {
        let (s, a, b) = make_snippet("    - item here", 6, 10);
        assert_eq!(s, "- item here");
        assert_eq!(&s[a..b], "item");
    }

    #[test]
    fn truncates_at_max_results() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "x\n".repeat(MAX_RESULTS)).unwrap();
        fs::write(dir.path().join("b.md"), "x\n").unwrap();
        let r = search(dir.path(), "x", false, false, false);
        assert_eq!(r.hits.len(), MAX_RESULTS);
        assert!(r.truncated);

        let dir2 = tempdir().unwrap();
        fs::write(dir2.path().join("a.md"), "x\n".repeat(MAX_RESULTS)).unwrap();
        let exact = search(dir2.path(), "x", false, false, false);
        assert_eq!(exact.hits.len(), MAX_RESULTS);
        assert!(!exact.truncated);
    }

    #[test]
    fn skips_hidden_node_modules_non_markdown_and_large_files() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::write(root.join(".obsidian/a.md"), "needle").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/readme.md"), "needle").unwrap();
        fs::write(root.join("notes.txt"), "needle").unwrap();
        fs::write(root.join("big.md"), format!("needle{}", "x".repeat(MAX_FILE_BYTES as usize))).unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/deep.markdown"), "needle").unwrap();
        fs::write(root.join("top.mdown"), "needle").unwrap();
        let r = search(root, "needle", false, false, false);
        let paths: Vec<String> = r.hits.iter().map(|h| h.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                root.join("top.mdown").to_string_lossy().into_owned(),
                root.join("sub").join("deep.markdown").to_string_lossy().into_owned(),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks_out_of_root() {
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "needle").unwrap();
        let dir = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.md"), dir.path().join("s.md")).unwrap();
        let r = search(dir.path(), "needle", false, false, false);
        assert!(r.hits.is_empty());
    }

    #[test]
    fn errors_and_empty_query() {
        let missing = search_in_folder_impl("/tmp/kalamos-no-such-dir-xyz", "a", false, false, false)
            .unwrap_err();
        assert_eq!(missing.kind, ErrorKind::NotFound);
        assert_eq!(
            search_in_folder_impl(" ", "a", false, false, false).unwrap_err().kind,
            ErrorKind::InvalidPath
        );
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "abc").unwrap();
        assert!(search(dir.path(), "", false, false, false).hits.is_empty());
    }
}
