use std::cmp::Ordering;
use std::fs;
use std::path::{Component, Path, PathBuf};

const IGNORED_DIRS: &[&str] = &["node_modules", ".git", "dist", ".claude", ".worktrees", "target"];

pub fn complete_paths(cwd: &Path, token: &str) -> Vec<String> {
    let marker = token.rfind('@').map(|index| &token[index + 1..]).unwrap_or(token);
    let (base_dir, prefix) = split_base_and_prefix(cwd, marker);
    let Ok(entries) = fs::read_dir(&base_dir) else {
        return Vec::new();
    };

    let mut results: Vec<PathSuggestion> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy().to_string();
            if !file_name.to_ascii_lowercase().starts_with(&prefix.to_ascii_lowercase()) {
                return None;
            }
            let file_type = entry.file_type().ok()?;
            if file_type.is_dir() && IGNORED_DIRS.contains(&file_name.as_str()) {
                return None;
            }
            let value = build_completion_value(cwd, marker, &file_name, &entry.path())?;
            Some(PathSuggestion { value, is_dir: file_type.is_dir() })
        })
        .collect();
    results.sort_by(PathSuggestion::cmp);
    results.truncate(8);
    results.into_iter().map(|suggestion| suggestion.value).collect()
}

fn split_base_and_prefix(cwd: &Path, marker: &str) -> (PathBuf, String) {
    if marker.is_empty() {
        return (cwd.to_path_buf(), String::new());
    }

    if let Some((dir, prefix)) = marker.rsplit_once('/') {
        let base = if dir.is_empty() {
            cwd.to_path_buf()
        } else {
            normalize_join(cwd, Path::new(dir))
        };
        (base, prefix.to_string())
    } else {
        (cwd.to_path_buf(), marker.to_string())
    }
}

fn build_completion_value(cwd: &Path, marker: &str, file_name: &str, path: &Path) -> Option<String> {
    let mut value = if marker.contains('/') {
        let base = marker.rsplit_once('/').map(|(dir, _)| dir).unwrap_or_default();
        join_marker_path(base, file_name)
    } else {
        path_relative_to(cwd, path)?
    };
    if path.is_dir() {
        value.push('/');
    }
    Some(value)
}

fn join_marker_path(base: &str, file_name: &str) -> String {
    if base.is_empty() {
        file_name.to_string()
    } else {
        format!("{base}/{file_name}")
    }
}

fn normalize_join(base: &Path, suffix: &Path) -> PathBuf {
    let mut path = base.to_path_buf();
    for component in suffix.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                path.pop();
            }
            Component::Normal(part) => path.push(part),
            Component::RootDir | Component::Prefix(_) => return suffix.to_path_buf(),
        }
    }
    path
}

fn path_relative_to(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|value| value.to_string_lossy().to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PathSuggestion {
    value: String,
    is_dir: bool,
}

impl PathSuggestion {
    fn cmp(left: &Self, right: &Self) -> Ordering {
        match right.is_dir.cmp(&left.is_dir) {
            Ordering::Equal => left.value.to_ascii_lowercase().cmp(&right.value.to_ascii_lowercase()),
            order => order,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir, write};
    use tempfile::tempdir;

    #[test]
    fn completes_relative_paths_while_ignoring_noise_dirs() {
        let dir = tempdir().expect("tempdir");
        create_dir(dir.path().join("src")).expect("src dir");
        create_dir(dir.path().join("node_modules")).expect("node_modules dir");
        write(dir.path().join("src").join("main.rs"), "fn main() {}\n").expect("write main");

        let results = complete_paths(dir.path(), "@src/m");
        assert_eq!(results, vec!["src/main.rs"]);
    }

    #[test]
    fn sorts_directories_before_files_with_case_insensitive_names() {
        let dir = tempdir().expect("tempdir");
        create_dir(dir.path().join("alpha")).expect("alpha dir");
        create_dir(dir.path().join("Zoo")).expect("zoo dir");
        write(dir.path().join("Beta.txt"), "beta\n").expect("write beta");
        write(dir.path().join("aardvark.txt"), "aardvark\n").expect("write aardvark");

        let results = complete_paths(dir.path(), "@");
        assert_eq!(results, vec!["alpha/", "Zoo/", "aardvark.txt", "Beta.txt"]);
    }

    #[test]
    fn completes_parent_relative_nested_paths() {
        let dir = tempdir().expect("tempdir");
        create_dir(dir.path().join("pkg")).expect("pkg dir");
        create_dir(dir.path().join("pkg").join("src")).expect("src dir");
        write(dir.path().join("pkg").join("Cargo.toml"), "[package]\nname = \"pkg\"\n").expect("write cargo");

        let cwd = dir.path().join("pkg").join("src");
        let results = complete_paths(&cwd, "@../C");
        assert_eq!(results, vec!["../Cargo.toml"]);
    }
}
