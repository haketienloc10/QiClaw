use crate::composer::ComposerMode;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FooterState {
    pub status_text: String,
    pub turn_summary_text: Option<String>,
    pub model_text: String,
    pub mode: ComposerMode,
    pub draft_present: bool,
    pub popup_open: bool,
    pub busy: bool,
    pub transcript_scrolled: bool,
    pub shift_enter_supported: bool,
}

impl Default for FooterState {
    fn default() -> Self {
        Self {
            status_text: "Ready".into(),
            turn_summary_text: None,
            model_text: String::new(),
            mode: ComposerMode::Normal,
            draft_present: false,
            popup_open: false,
            busy: false,
            transcript_scrolled: false,
            shift_enter_supported: false,
        }
    }
}

impl FooterState {
    fn newline_hint(&self) -> &'static str {
        if self.shift_enter_supported {
            "Shift+Enter newline"
        } else {
            "Ctrl+J newline"
        }
    }

    pub fn primary_hints(&self) -> Vec<&'static str> {
        if self.transcript_scrolled {
            return vec!["PgDn follow", "↑↓ scroll"];
        }

        if self.busy {
            return vec!["↑↓ scroll", "PgDn latest"];
        }

        match self.mode {
            ComposerMode::HistorySearch => vec!["Type query", "Enter restore", "Esc cancel"],
            ComposerMode::Shell => vec!["Enter run", self.newline_hint(), "Esc clear"],
            ComposerMode::Slash | ComposerMode::FileCompletion if self.popup_open => {
                vec!["Tab accept", "↑↓ choose", "Esc close"]
            }
            _ if !self.draft_present => vec!["Enter send", "/ commands", "Ctrl+R history"],
            _ => vec!["Enter send", self.newline_hint(), "Esc clear"],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches_hints_by_mode() {
        let empty = FooterState::default();
        assert_eq!(empty.primary_hints()[0], "Enter send");

        let busy = FooterState { busy: true, ..FooterState::default() };
        assert_eq!(busy.primary_hints()[0], "↑↓ scroll");

        let scrolled = FooterState { transcript_scrolled: true, ..FooterState::default() };
        assert_eq!(scrolled.primary_hints()[0], "PgDn follow");

        let shell = FooterState {
            mode: ComposerMode::Shell,
            draft_present: true,
            shift_enter_supported: true,
            ..FooterState::default()
        };
        assert_eq!(shell.primary_hints()[0], "Enter run");
    }

    #[test]
    fn draft_hints_prioritize_send_newline_and_history() {
        let draft = FooterState {
            draft_present: true,
            shift_enter_supported: true,
            ..FooterState::default()
        };

        assert_eq!(
            draft.primary_hints(),
            vec!["Enter send", "Shift+Enter newline", "Esc clear"]
        );
    }

    #[test]
    fn history_search_hints_match_terminal_search_flow() {
        let state = FooterState {
            mode: ComposerMode::HistorySearch,
            popup_open: true,
            ..FooterState::default()
        };

        assert_eq!(
            state.primary_hints(),
            vec!["Type query", "Enter restore", "Esc cancel"]
        );
    }

    #[test]
    fn fallback_newline_hint_uses_ctrl_j_without_enhanced_keys() {
        let draft = FooterState {
            draft_present: true,
            ..FooterState::default()
        };

        assert_eq!(
            draft.primary_hints(),
            vec!["Enter send", "Ctrl+J newline", "Esc clear"]
        );
    }
}
