use ratatui::layout::{Constraint, Layout, Rect};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TranscriptLayout {
    pub transcript: Rect,
    pub footer: Rect,
    pub composer: Rect,
    pub popup: Rect,
}

pub fn split_root(area: Rect, popup_height: u16) -> TranscriptLayout {
    let composer_height = if popup_height == 0 {
        3
    } else {
        4 + popup_height.min(6)
    };

    let vertical = Layout::vertical([
        Constraint::Min(5),
        Constraint::Length(1),
        Constraint::Length(composer_height),
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
        footer: vertical[1],
        composer,
        popup,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_space_for_popup_without_overflowing() {
        let layout = split_root(
            Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 24,
            },
            5,
        );

        assert_eq!(layout.transcript.height, 14);
        assert_eq!(layout.footer.height, 1);
        assert_eq!(layout.composer.height, 9);
        assert!(layout.popup.height <= layout.composer.height);
    }

    #[test]
    fn keeps_bottom_pane_compact_when_popup_is_closed() {
        let layout = split_root(
            Rect {
                x: 0,
                y: 0,
                width: 80,
                height: 18,
            },
            0,
        );

        assert_eq!(layout.footer.height, 1);
        assert_eq!(layout.composer.height, 3);
        assert_eq!(layout.transcript.height, 14);
    }
}
