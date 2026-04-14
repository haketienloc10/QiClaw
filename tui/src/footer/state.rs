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
            return vec!["Scrolled", "↓ follow live", "PgDn bottom"];
        }

        if self.busy {
            return vec!["Waiting for agent", "↑↓ scroll", "Ctrl+C quit"];
        }

        match self.mode {
            ComposerMode::HistorySearch => vec!["Type to filter history", "↑↓ choose", "Tab restore", "Esc cancel"],
            ComposerMode::Shell => vec!["Enter run shell", "Ctrl+J newline", "Esc normal"],
            ComposerMode::Slash | ComposerMode::FileCompletion if self.popup_open => {
                vec!["Tab accept", "↑↓ choose", "Esc close"]
            }
            _ if !self.draft_present => vec!["Enter submit", "/ slash", "! shell", "Ctrl+R history"],
            _ => vec!["Enter submit", "Ctrl+J newline", "Esc reset"],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches_hints_by_mode() {
        let empty = FooterState::default();
        assert_eq!(empty.primary_hints()[0], "Enter submit");

        let busy = FooterState { busy: true, ..FooterState::default() };
        assert_eq!(busy.primary_hints()[0], "Waiting for agent");

        let scrolled = FooterState { transcript_scrolled: true, ..FooterState::default() };
        assert_eq!(scrolled.primary_hints()[0], "Scrolled");

        let shell = FooterState {
            mode: ComposerMode::Shell,
            draft_present: true,
            ..FooterState::default()
        };
        assert_eq!(shell.primary_hints()[0], "Enter run shell");
    }

    #[test]
    fn draft_hints_do_not_advertise_unsupported_editor_mode() {
        let draft = FooterState {
            draft_present: true,
            ..FooterState::default()
        };

        assert_eq!(
            draft.primary_hints(),
            vec!["Enter submit", "Ctrl+J newline", "Esc reset"]
        );
    }
}
