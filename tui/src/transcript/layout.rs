use ratatui::layout::{Constraint, Layout, Rect};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TranscriptLayout {
    pub transcript: Rect,
    pub status: Rect,
    pub footer: Rect,
    pub composer: Rect,
    pub popup: Rect,
}

pub fn split_root(area: Rect, popup_height: u16) -> TranscriptLayout {
    let desired_composer_height = if popup_height == 0 {
        3
    } else {
        4 + popup_height.min(6)
    };
    let transcript_min_height = if popup_height > 0 && area.height <= 12 { 6 } else { 5 };
    let composer_height = desired_composer_height.min(
        area.height
            .saturating_sub(transcript_min_height)
            .saturating_sub(2),
    );

    let vertical = Layout::vertical([
        Constraint::Min(transcript_min_height),
        Constraint::Length(1),
        Constraint::Length(composer_height),
        Constraint::Length(1),
    ])
    .split(area);

    let composer = vertical[2];
    let popup = Rect {
        x: composer.x,
        y: composer.y,
        width: composer.width,
        height: popup_height.min(composer.height.saturating_sub(1)),
    };

    TranscriptLayout {
        transcript: vertical[0],
        status: vertical[1],
        footer: vertical[3],
        composer,
        popup,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_root_into_transcript_status_composer_and_footer() {
        let layout = split_root(
            Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 24,
            },
            0,
        );

        assert_eq!(layout.status.height, 1);
        assert_eq!(layout.footer.height, 1);
        assert_eq!(layout.composer.height, 3);
        assert!(
            layout.transcript.height
                > layout.composer.height + layout.status.height + layout.footer.height
        );
    }

    #[test]
    fn keeps_transcript_priority_on_short_terminal() {
        let layout = split_root(
            Rect {
                x: 0,
                y: 0,
                width: 80,
                height: 12,
            },
            0,
        );

        assert!(layout.transcript.height >= 7);
        assert_eq!(layout.status.height, 1);
        assert_eq!(layout.footer.height, 1);
    }

    #[test]
    fn popup_growth_expands_bottom_pane_before_transcript_collapses_too_far() {
        let layout = split_root(
            Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 24,
            },
            5,
        );

        assert_eq!(layout.status.height, 1);
        assert_eq!(layout.footer.height, 1);
        assert!(layout.composer.height >= 4);
        assert!(layout.popup.height >= 5);
        assert!(layout.transcript.height >= 10);
    }

    #[test]
    fn compresses_bottom_layers_before_transcript_on_short_terminal_with_popup() {
        let layout = split_root(
            Rect {
                x: 0,
                y: 0,
                width: 80,
                height: 12,
            },
            5,
        );

        assert!(layout.transcript.height >= 6);
        assert_eq!(layout.status.height, 1);
        assert_eq!(layout.footer.height, 1);
        assert!(layout.composer.height <= 4);
        assert!(layout.popup.height <= 3);
    }
}
