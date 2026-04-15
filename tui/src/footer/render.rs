use ratatui::prelude::*;
use ratatui::widgets::Paragraph;

use crate::widgets::key_hint::join_key_hints;

use super::state::FooterState;

pub fn render_status_strip(frame: &mut Frame<'_>, area: Rect, state: &FooterState) {
    let max_status_width = area.width as usize;
    let text = truncate(&state.status_text, max_status_width);
    let line = Line::from(Span::styled(text, Style::default().fg(Color::DarkGray)));
    frame.render_widget(Paragraph::new(line), area);
}

pub fn render_footer_rail(frame: &mut Frame<'_>, area: Rect, state: &FooterState) {
    let hints = join_key_hints(area.width as usize, &state.primary_hints());
    let line = Line::from(Span::styled(hints, Style::default().fg(Color::Gray)));
    frame.render_widget(Paragraph::new(line), area);
}

fn truncate(text: &str, max_width: usize) -> String {
    text.chars().take(max_width).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::footer::state::FooterState;
    use ratatui::{backend::TestBackend, Terminal};

    fn rendered_line(width: u16, render_fn: impl FnOnce(&mut Frame<'_>, Rect, &FooterState), state: &FooterState) -> String {
        let backend = TestBackend::new(width, 1);
        let mut terminal = Terminal::new(backend).expect("terminal");

        terminal.draw(|frame| render_fn(frame, frame.area(), state)).expect("draw");

        let buffer = terminal.backend().buffer();
        (0..width).map(|x| buffer[(x, 0)].symbol()).collect::<String>()
    }

    #[test]
    fn status_strip_renders_status_without_footer_hints() {
        let state = FooterState {
            status_text: "Ready".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(40, render_status_strip, &state);

        assert!(rendered.contains("Ready"));
        assert!(!rendered.contains("shortcuts"));
        assert!(!rendered.contains("send"));
    }

    #[test]
    fn status_strip_truncates_long_status_text_to_available_width() {
        let state = FooterState {
            status_text: "VeryLongStatus".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(12, render_status_strip, &state);

        assert!(rendered.contains("VeryLongSta"));
        assert!(!rendered.contains("shortcuts"));
    }

    #[test]
    fn footer_rail_renders_hints_without_status_text() {
        let state = FooterState {
            status_text: "Ready".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(40, render_footer_rail, &state);

        assert!(!rendered.contains("Ready"));
        assert!(rendered.contains("[Enter] send"));
        assert!(rendered.contains("[/] commands"));
    }

    #[test]
    fn footer_rail_uses_full_width_for_hints() {
        let state = FooterState {
            status_text: "VeryLongStatus".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(24, render_footer_rail, &state);

        assert!(rendered.contains("[Enter] send"));
        assert!(!rendered.contains("VeryLongSta"));
        assert!(!rendered.contains("Ready"));
    }
}
