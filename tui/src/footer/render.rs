use ratatui::prelude::*;
use ratatui::widgets::Paragraph;

use crate::widgets::key_hint::join_key_hints;

use super::state::FooterState;

pub fn render(frame: &mut Frame<'_>, area: Rect, state: &FooterState) {
    let mut text = state.status_text.clone();
    let max_status_width = area.width.saturating_sub(12) as usize;
    if text.chars().count() > max_status_width {
        text = text.chars().take(max_status_width.saturating_sub(1)).collect();
    }

    let used_width = text.chars().count().saturating_add(1);
    let remaining_width = area.width as usize;
    let hints = join_key_hints(remaining_width.saturating_sub(used_width), &state.primary_hints());

    let line = Line::from(vec![
        Span::styled(text, Style::default().fg(Color::Cyan)),
        Span::raw(" "),
        Span::styled(hints, Style::default().fg(Color::DarkGray)),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::footer::state::FooterState;
    use ratatui::{backend::TestBackend, Terminal};

    #[test]
    fn renders_status_and_hints() {
        let backend = TestBackend::new(40, 1);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let state = FooterState {
            status_text: "Ready".into(),
            ..FooterState::default()
        };

        terminal.draw(|frame| render(frame, frame.area(), &state)).expect("draw");

        let buffer = terminal.backend().buffer();
        let rendered = (0..1)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("Ready"));
        assert!(rendered.contains("[?] shortcuts"));
    }

    #[test]
    fn truncates_hints_to_remaining_width_after_status_text() {
        let backend = TestBackend::new(24, 1);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let state = FooterState {
            status_text: "VeryLongStatus".into(),
            ..FooterState::default()
        };

        terminal.draw(|frame| render(frame, frame.area(), &state)).expect("draw");

        let buffer = terminal.backend().buffer();
        let rendered = (0..1)
            .map(|y| {
                (0..24)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("VeryLongSta"));
        assert!(!rendered.contains("Ctrl+R"));
    }

    #[test]
    fn uses_actual_remaining_width_for_hints_instead_of_half_split() {
        let backend = TestBackend::new(40, 1);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let state = FooterState {
            status_text: "Ready".into(),
            ..FooterState::default()
        };

        terminal.draw(|frame| render(frame, frame.area(), &state)).expect("draw");

        let buffer = terminal.backend().buffer();
        let rendered = (0..1)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("[Enter] send"));
        assert!(rendered.contains("[?] shortcuts"));
    }
}
