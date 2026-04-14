use crate::composer::ComposerMode;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FooterState {
    pub status_text: String,
    pub mode: ComposerMode,
    pub draft_present: bool,
    pub popup_open: bool,
    pub busy: bool,
    pub transcript_scrolled: bool,
}

impl Default for FooterState {
    fn default() -> Self {
        Self {
            status_text: "Ready".into(),
            mode: ComposerMode::Normal,
            draft_present: false,
            popup_open: false,
            busy: false,
            transcript_scrolled: false,
        }
    }
}

impl FooterState {
    pub fn primary_hints(&self) -> Vec<&'static str> {
        if self.transcript_scrolled {
            return vec!["↓ follow live", "PgDn bottom", "↑↓ scroll"];
        }

        if self.busy {
            return vec!["↑↓ scroll", "PgDn bottom", "Ctrl+C quit"];
        }

        match self.mode {
            ComposerMode::HistorySearch => vec!["Type query", "↑↓ choose", "Enter restore", "Esc cancel"],
            ComposerMode::Shell => vec!["Enter run shell", "Shift+Enter newline", "Esc clear"],
            ComposerMode::Slash | ComposerMode::FileCompletion if self.popup_open => {
                vec!["Tab accept", "↑↓ choose", "Enter send", "Esc close"]
            }
            _ if !self.draft_present => vec!["? shortcuts", "Enter send", "/ slash", "Ctrl+R history"],
            _ => vec!["Enter send", "Shift+Enter newline", "Ctrl+R history", "Esc clear"],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches_hints_by_mode() {
        let empty = FooterState::default();
        assert_eq!(empty.primary_hints()[0], "? shortcuts");

        let busy = FooterState { busy: true, ..FooterState::default() };
        assert_eq!(busy.primary_hints()[0], "↑↓ scroll");

        let scrolled = FooterState { transcript_scrolled: true, ..FooterState::default() };
        assert_eq!(scrolled.primary_hints()[0], "↓ follow live");

        let shell = FooterState {
            mode: ComposerMode::Shell,
            draft_present: true,
            ..FooterState::default()
        };
        assert_eq!(shell.primary_hints()[0], "Enter run shell");
    }

    #[test]
    fn draft_hints_prioritize_send_newline_and_history() {
        let draft = FooterState {
            draft_present: true,
            ..FooterState::default()
        };

        assert_eq!(
            draft.primary_hints(),
            vec!["Enter send", "Shift+Enter newline", "Ctrl+R history", "Esc clear"]
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
            vec!["Type query", "↑↓ choose", "Enter restore", "Esc cancel"]
        );
    }
}
