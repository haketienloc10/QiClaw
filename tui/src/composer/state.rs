use std::path::Path;

use crate::protocol::SlashCatalogEntry;

use super::command_popup::PopupListState;
use super::file_completion::complete_paths;
use super::history_search::{HistorySearchMatch, HistorySearchState};
use super::slash_commands::filter_commands;
use super::textarea::TextAreaState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerMode {
    Normal,
    Slash,
    Shell,
    FileCompletion,
    HistorySearch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitAction {
    Prompt(String),
    Slash { command: String, args_text: Option<String> },
    Shell { command: String, args: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerSubmit {
    pub action: SubmitAction,
    pub raw_input: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerState {
    pub textarea: TextAreaState,
    pub mode: ComposerMode,
    pub popup: PopupListState,
    pub slash_matches: Vec<SlashCatalogEntry>,
    pub file_matches: Vec<String>,
    pub history: Vec<String>,
    pub history_search: HistorySearchState,
    pub busy: bool,
    pub editor_warning: Option<String>,
}

impl Default for ComposerState {
    fn default() -> Self {
        Self {
            textarea: TextAreaState::default(),
            mode: ComposerMode::Normal,
            popup: PopupListState::default(),
            slash_matches: Vec::new(),
            file_matches: Vec::new(),
            history: Vec::new(),
            history_search: HistorySearchState::default(),
            busy: false,
            editor_warning: None,
        }
    }
}

impl ComposerState {
    pub fn set_busy(&mut self, value: bool) {
        self.busy = value;
    }

    pub fn refresh_modes(&mut self, catalog: &[SlashCatalogEntry], cwd: &Path) {
        let token = self.textarea.current_token().to_string();
        if self.history_search.active {
            self.mode = ComposerMode::HistorySearch;
            return;
        }

        if token.starts_with('/') {
            self.mode = ComposerMode::Slash;
            self.slash_matches = filter_commands(catalog, &token).into_iter().cloned().collect();
            if self.popup.selected >= self.slash_matches.len() {
                self.popup.selected = 0;
            }
            self.popup.visible = !self.slash_matches.is_empty();
            return;
        }

        if self.textarea.text.trim_start().starts_with('!') {
            self.mode = ComposerMode::Shell;
            self.popup.close();
            return;
        }

        if token.contains('@') {
            self.mode = ComposerMode::FileCompletion;
            self.file_matches = complete_paths(cwd, &token);
            if self.popup.selected >= self.file_matches.len() {
                self.popup.selected = 0;
            }
            self.popup.visible = !self.file_matches.is_empty();
            return;
        }

        self.mode = ComposerMode::Normal;
        self.popup.close();
    }

    pub fn insert_char(&mut self, ch: char, catalog: &[SlashCatalogEntry], cwd: &Path) {
        self.textarea.insert_char(ch);
        self.refresh_modes(catalog, cwd);
    }

    pub fn insert_newline(&mut self) {
        self.textarea.insert_char('\n');
    }

    pub fn backspace(&mut self, catalog: &[SlashCatalogEntry], cwd: &Path) {
        self.textarea.backspace();
        self.refresh_modes(catalog, cwd);
    }

    pub fn move_popup_next(&mut self) {
        let len = self.popup_len();
        self.popup.select_next(len);
    }

    pub fn move_popup_prev(&mut self) {
        let len = self.popup_len();
        self.popup.select_prev(len);
    }

    pub fn accept_popup(&mut self, catalog: &[SlashCatalogEntry], cwd: &Path) -> bool {
        match self.mode {
            ComposerMode::Slash => {
                let Some(entry) = self.slash_matches.get(self.popup.selected).cloned() else {
                    return false;
                };
                if self.textarea.current_token() == entry.name {
                    return false;
                }
                let replacement = format!("{} ", entry.name);
                self.replace_current_token(&replacement);
                self.refresh_modes(catalog, cwd);
                true
            }
            ComposerMode::FileCompletion => {
                let Some(entry) = self.file_matches.get(self.popup.selected).cloned() else {
                    return false;
                };
                self.replace_current_token(&format!("@{}", entry));
                self.refresh_modes(catalog, cwd);
                true
            }
            ComposerMode::HistorySearch => {
                let Some(value) = self.history_search.matches.get(self.popup.selected).cloned() else {
                    return false;
                };
                let existing_draft = self.textarea.text.trim().to_string();
                let restored = if existing_draft.is_empty() || existing_draft == value.text {
                    value.text
                } else {
                    format!("{}\n{existing_draft}", value.text)
                };
                self.textarea.set_text(restored);
                self.history_search.active = false;
                self.history_search.query.clear();
                self.mode = ComposerMode::Normal;
                self.popup.close();
                true
            }
            _ => false,
        }
    }

    pub fn escape(&mut self) {
        if self.history_search.active {
            self.history_search.active = false;
            self.history_search.query.clear();
        }
        self.mode = ComposerMode::Normal;
        self.popup.close();
        self.file_matches.clear();
        self.editor_warning = None;
    }

    pub fn start_history_search(&mut self) {
        self.history_search.active = true;
        self.history_search.query.clear();
        self.history_search.refresh(&self.history);
        self.mode = ComposerMode::HistorySearch;
        self.popup.selected = 0;
        self.popup.visible = !self.history_search.matches.is_empty();
    }

    pub fn update_history_query(&mut self, query: String) {
        self.history_search.query = query;
        self.history_search.selected = self.popup.selected;
        self.history_search.refresh(&self.history);
        self.popup.selected = self.history_search.selected.min(self.history_search.matches.len().saturating_sub(1));
        self.popup.visible = !self.history_search.matches.is_empty();
    }

    pub fn note_editor_unsupported(&mut self) {
        self.editor_warning = Some("External editor mode is not supported in this build. Keep typing here or paste content directly.".into());
    }

    pub fn submit(&mut self) -> Option<ComposerSubmit> {
        let raw_input = self.textarea.text.clone();
        let trimmed = raw_input.trim();
        if trimmed.is_empty() {
            return None;
        }

        let action = if trimmed.starts_with('!') {
            let shell = trimmed.trim_start_matches('!').trim();
            let mut parts = shell.split_whitespace();
            let command = parts.next()?.to_string();
            let args = parts.map(str::to_string).collect();
            SubmitAction::Shell { command, args }
        } else if trimmed.starts_with('/') {
            let mut parts = trimmed.splitn(2, char::is_whitespace);
            let command = parts.next()?.to_string();
            let args_text = parts.next().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
            SubmitAction::Slash { command, args_text }
        } else {
            SubmitAction::Prompt(raw_input.clone())
        };

        self.history.push(raw_input.clone());
        self.textarea = TextAreaState::default();
        self.mode = ComposerMode::Normal;
        self.popup.close();
        self.file_matches.clear();
        self.slash_matches.clear();
        Some(ComposerSubmit { action, raw_input })
    }

    fn popup_len(&self) -> usize {
        match self.mode {
            ComposerMode::Slash => self.slash_matches.len(),
            ComposerMode::FileCompletion => self.file_matches.len(),
            ComposerMode::HistorySearch => self.history_search.matches.len(),
            _ => 0,
        }
    }

    fn replace_current_token(&mut self, replacement: &str) {
        let left = &self.textarea.text[..self.textarea.cursor];
        let start = left
            .char_indices()
            .rev()
            .find(|(_, ch)| ch.is_whitespace())
            .map(|(index, ch)| index + ch.len_utf8())
            .unwrap_or(0);
        self.textarea.text.replace_range(start..self.textarea.cursor, replacement);
        self.textarea.cursor = start + replacement.len();
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::protocol::{SlashCatalogKind, SlashCatalogEntry};

    fn catalog() -> Vec<SlashCatalogEntry> {
        vec![
            SlashCatalogEntry {
                name: "/status".into(),
                description: "Show status".into(),
                usage: Some("/status".into()),
                kind: SlashCatalogKind::Direct,
            },
            SlashCatalogEntry {
                name: "/review".into(),
                description: "Review work".into(),
                usage: Some("/review [focus]".into()),
                kind: SlashCatalogKind::Prompt,
            },
        ]
    }

    #[test]
    fn enters_and_exits_slash_mode() {
        let mut state = ComposerState::default();
        let catalog = catalog();
        state.insert_char('/', &catalog, Path::new("."));
        state.insert_char('r', &catalog, Path::new("."));

        assert_eq!(state.mode, ComposerMode::Slash);
        assert_eq!(state.slash_matches[0].name, "/review");

        state.escape();
        assert_eq!(state.mode, ComposerMode::Normal);
        assert!(!state.popup.visible);
    }

    #[test]
    fn supports_newline_insertion_and_submit_behavior() {
        let mut state = ComposerState::default();
        state.textarea.insert_str("hello");
        state.insert_newline();
        state.textarea.insert_str("world");

        let submit = state.submit().expect("submit prompt");
        assert_eq!(submit.action, SubmitAction::Prompt("hello\nworld".into()));
        assert!(state.textarea.text.is_empty());
    }

    #[test]
    fn submits_shell_and_slash_modes() {
        let mut shell = ComposerState::default();
        shell.textarea.set_text("!git status".into());
        let shell_submit = shell.submit().expect("shell submit");
        assert_eq!(
            shell_submit.action,
            SubmitAction::Shell {
                command: "git".into(),
                args: vec!["status".into()],
            }
        );

        let mut slash = ComposerState::default();
        slash.textarea.set_text("/review src/cli".into());
        let slash_submit = slash.submit().expect("slash submit");
        assert_eq!(
            slash_submit.action,
            SubmitAction::Slash {
                command: "/review".into(),
                args_text: Some("src/cli".into()),
            }
        );
    }

    #[test]
    fn escapes_history_search_and_clears_transient_mode() {
        let mut state = ComposerState::default();
        state.history = vec!["first prompt".into()];
        state.start_history_search();
        assert_eq!(state.mode, ComposerMode::HistorySearch);

        state.escape();

        assert_eq!(state.mode, ComposerMode::Normal);
        assert!(!state.history_search.active);
    }

    #[test]
    fn accepts_selected_history_match_from_popup_state() {
        let mut state = ComposerState::default();
        state.history = vec!["first prompt".into(), "second prompt".into()];
        state.start_history_search();
        state.popup.selected = 1;

        let accepted = state.accept_popup(&catalog(), Path::new("."));

        assert!(accepted);
        assert_eq!(state.textarea.text, "first prompt");
        assert_eq!(state.mode, ComposerMode::Normal);
        assert!(!state.popup.visible);
    }

    #[test]
    fn accepting_slash_popup_with_trailing_space_returns_to_normal_mode() {
        let mut state = ComposerState::default();
        let catalog = catalog();
        state.insert_char('/', &catalog, Path::new("."));
        state.insert_char('r', &catalog, Path::new("."));

        let accepted = state.accept_popup(&catalog, Path::new("."));

        assert!(accepted);
        assert_eq!(state.textarea.text, "/review ");
        assert_eq!(state.mode, ComposerMode::Normal);
        assert!(!state.popup.visible);
    }

    #[test]
    fn exact_slash_match_does_not_consume_enter_for_completion() {
        let mut state = ComposerState::default();
        let catalog = catalog();
        state.textarea.set_text("/status".into());
        state.refresh_modes(&catalog, Path::new("."));

        let accepted = state.accept_popup(&catalog, Path::new("."));

        assert!(!accepted);
        assert_eq!(state.textarea.text, "/status");
        assert_eq!(state.mode, ComposerMode::Slash);
        assert!(state.popup.visible);
    }

    #[test]
    fn keeps_history_popup_selection_on_same_entry_when_query_changes() {
        let mut state = ComposerState::default();
        state.history = vec!["build release".into(), "build debug".into(), "test tui".into()];
        state.start_history_search();
        state.popup.selected = 1;

        state.update_history_query("build".into());

        assert_eq!(state.popup.selected, 0);
        assert_eq!(
            state.history_search.matches,
            vec![
                HistorySearchMatch {
                    history_index: 1,
                    text: "build debug".into(),
                },
                HistorySearchMatch {
                    history_index: 0,
                    text: "build release".into(),
                },
            ]
        );
        assert_eq!(state.history_search.matches[state.popup.selected].text, "build debug");
    }

    #[test]
    fn keeps_history_popup_selection_on_exact_duplicate_when_query_changes() {
        let mut state = ComposerState::default();
        state.history = vec![
            "duplicate prompt".into(),
            "keep me".into(),
            "duplicate prompt".into(),
        ];
        state.start_history_search();
        state.popup.selected = 2;

        state.update_history_query("prompt".into());

        assert_eq!(
            state.history_search.matches,
            vec![
                HistorySearchMatch {
                    history_index: 2,
                    text: "duplicate prompt".into(),
                },
                HistorySearchMatch {
                    history_index: 0,
                    text: "duplicate prompt".into(),
                },
            ]
        );
        assert_eq!(state.popup.selected, 1);
    }

    #[test]
    fn accepting_history_restores_existing_draft_after_selected_entry() {
        let mut state = ComposerState::default();
        state.history = vec!["first prompt".into(), "second prompt".into()];
        state.textarea.set_text("draft context".into());
        state.start_history_search();

        let accepted = state.accept_popup(&catalog(), Path::new("."));

        assert!(accepted);
        assert_eq!(state.textarea.text, "second prompt\ndraft context");
        assert_eq!(state.mode, ComposerMode::Normal);
        assert!(!state.popup.visible);
    }

    #[test]
    fn accepting_file_completion_replaces_only_current_path_marker() {
        let mut state = ComposerState::default();
        state.textarea.set_text("open @src/li and @src/ma".into());
        state.mode = ComposerMode::FileCompletion;
        state.file_matches = vec!["src/main.rs".into()];
        state.popup.visible = true;

        let accepted = state.accept_popup(&catalog(), Path::new("."));

        assert!(accepted);
        assert_eq!(state.textarea.text, "open @src/li and @src/main.rs");
    }
}
