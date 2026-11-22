use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub const MAX_EXCERPT_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Dir,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub kind: NodeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub mtime_ms: u64,
    pub excerpt: String,
}

pub fn is_ignored_name(name: &str) -> bool {
    name.starts_with('.') || name == ".git" || name == "node_modules"
}

pub fn is_markdown_name(name: &str) -> bool {
    crate::open_with::has_markdown_extension(Path::new(name))
}

pub fn extract_excerpt(content: &str) -> String {
    let first_non_empty = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    first_non_empty.chars().take(MAX_EXCERPT_CHARS).collect()
}

fn validate_dir_path(path: &str) -> Result<&Path, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let root = Path::new(path);
    if !root.exists() {
        return Err(AppError::not_found(format!(
            "Directory does not exist: {path}"
        )));
    }
    if !root.is_dir() {
        return Err(AppError::invalid_path(format!(
            "Path is not a directory: {path}"
        )));
    }
    Ok(root)
}

fn build_tree_node(dir_path: &Path) -> Result<TreeNode, AppError> {
    let name = dir_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| dir_path.to_string_lossy().into_owned());
    let path_str = dir_path.to_string_lossy().into_owned();

    let mut children = Vec::new();
    let entries = fs::read_dir(dir_path)?;

    for entry_res in entries {
        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_name = entry.file_name();
        let Some(entry_name) = file_name.to_str() else {
            continue;
        };
        if is_ignored_name(entry_name) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // Avoid following symlinks to prevent directory loops
        if file_type.is_symlink() {
            continue;
        }
        let entry_path = entry.path();
        if file_type.is_dir() {
            if let Ok(child_dir) = build_tree_node(&entry_path) {
                children.push(child_dir);
            }
        } else if file_type.is_file() && is_markdown_name(entry_name) {
            children.push(TreeNode {
                name: entry_name.to_string(),
                path: entry_path.to_string_lossy().into_owned(),
                kind: NodeKind::File,
                children: None,
            });
        }
    }

    children.sort_by(|a, b| {
        let a_is_dir = matches!(a.kind, NodeKind::Dir);
        let b_is_dir = matches!(b.kind, NodeKind::Dir);
        b_is_dir
            .cmp(&a_is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(TreeNode {
        name,
        path: path_str,
        kind: NodeKind::Dir,
        children: Some(children),
    })
}

pub fn read_tree_impl(path: &str) -> Result<TreeNode, AppError> {
    let root = validate_dir_path(path)?;
    build_tree_node(root)
}

fn collect_markdown_files(dir_path: &Path, out: &mut Vec<FileEntry>) -> Result<(), AppError> {
    let entries = fs::read_dir(dir_path)?;
    for entry_res in entries {
        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_name = entry.file_name();
        let Some(entry_name) = file_name.to_str() else {
            continue;
        };
        if is_ignored_name(entry_name) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let entry_path = entry.path();
        if file_type.is_dir() {
            let _ = collect_markdown_files(&entry_path, out);
        } else if file_type.is_file() && is_markdown_name(entry_name) {
            let mtime_ms = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let excerpt = fs::read(&entry_path)
                .map(|bytes| {
                    let text = String::from_utf8_lossy(&bytes);
                    extract_excerpt(&text)
                })
                .unwrap_or_default();
            out.push(FileEntry {
                path: entry_path.to_string_lossy().into_owned(),
                name: entry_name.to_string(),
                mtime_ms,
                excerpt,
            });
        }
    }
    Ok(())
}

pub fn list_files_impl(path: &str) -> Result<Vec<FileEntry>, AppError> {
    let root = validate_dir_path(path)?;
    let mut files = Vec::new();
    collect_markdown_files(root, &mut files)?;
    files.sort_by(|a, b| {
        b.mtime_ms
            .cmp(&a.mtime_ms)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(files)
}

#[tauri::command]
pub fn read_tree(path: String) -> Result<TreeNode, AppError> {
    read_tree_impl(&path)
}

#[tauri::command]
pub fn list_files(path: String) -> Result<Vec<FileEntry>, AppError> {
    list_files_impl(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use std::thread;
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn filters_hidden_git_node_modules_non_md_and_sorts_dirs_first_case_insensitive() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();

        // Ignored entries
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config.md"), "# Git").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/readme.md"), "# NPM").unwrap();
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::write(root.join(".obsidian/workspace.md"), "# Hidden dir").unwrap();
        fs::write(root.join(".hidden.md"), "# Hidden file").unwrap();
        fs::write(root.join("image.png"), "png").unwrap();
        fs::write(root.join("notes.txt"), "txt").unwrap();

        // Included folders and files
        fs::create_dir_all(root.join("zeta")).unwrap();
        fs::create_dir_all(root.join("Alpha")).unwrap();
        fs::write(root.join("Alpha/guide.MARKDOWN"), "# Guide").unwrap();
        fs::write(root.join("beta.md"), "# Beta").unwrap();
        fs::write(root.join("apple.md"), "# Apple").unwrap();
        fs::write(root.join("Banana.markdown"), "# Banana").unwrap();

        let tree = read_tree_impl(root.to_str().unwrap()).expect("read_tree_impl");
        assert_eq!(tree.kind, NodeKind::Dir);
        let children = tree.children.expect("root children");

        let names: Vec<(&str, &NodeKind)> = children
            .iter()
            .map(|c| (c.name.as_str(), &c.kind))
            .collect();
        assert_eq!(
            names,
            vec![
                ("Alpha", &NodeKind::Dir),
                ("zeta", &NodeKind::Dir),
                ("apple.md", &NodeKind::File),
                ("Banana.markdown", &NodeKind::File),
                ("beta.md", &NodeKind::File),
            ]
        );

        // Verify file nodes have children == None (omitted in JSON)
        let apple_json = serde_json::to_value(&children[2]).unwrap();
        assert_eq!(apple_json["kind"], "file");
        assert!(apple_json.get("children").is_none());

        // Verify nested folder children
        let alpha_children = children[0].children.as_ref().unwrap();
        assert_eq!(alpha_children.len(), 1);
        assert_eq!(alpha_children[0].name, "guide.MARKDOWN");
    }

    #[test]
    fn excerpt_skips_blank_lines_and_truncates_cjk_at_120_chars_safely() {
        let long_cjk = format!("   \n\n  # {}尾端超過一百二十字的內容", "蘆葦筆莎草紙".repeat(22));
        let excerpt = extract_excerpt(&long_cjk);
        assert_eq!(excerpt.chars().count(), 120);
        assert!(excerpt.starts_with("# 蘆葦筆莎草紙"));

        assert_eq!(extract_excerpt("   \n\t\n  "), "");
        assert_eq!(extract_excerpt("\n# 第一行標題\n第二行"), "# 第一行標題");
    }

    #[test]
    fn list_files_sorts_by_mtime_desc_and_extracts_excerpt() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();

        let older = root.join("older.md");
        fs::write(&older, "\n# 較舊的文章\n內容").unwrap();

        thread::sleep(Duration::from_millis(25));

        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let newer = sub.join("newer.markdown");
        fs::write(&newer, "# 較新的文章 Newer\n內容").unwrap();

        let list = list_files_impl(root.to_str().unwrap()).expect("list_files_impl");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "newer.markdown");
        assert_eq!(list[0].excerpt, "# 較新的文章 Newer");
        assert_eq!(list[1].name, "older.md");
        assert_eq!(list[1].excerpt, "# 較舊的文章");
        assert!(list[0].mtime_ms >= list[1].mtime_ms);
    }

    #[test]
    fn read_tree_and_list_files_error_handling() {
        let empty_err = read_tree_impl("  ").unwrap_err();
        assert_eq!(empty_err.kind, ErrorKind::InvalidPath);

        let missing_err = list_files_impl("/tmp/kalamos-non-existent-folder-xyz").unwrap_err();
        assert_eq!(missing_err.kind, ErrorKind::NotFound);
    }
}
