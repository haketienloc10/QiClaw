use ratatui::prelude::*;
use ratatui::widgets::Paragraph;

use crate::widgets::key_hint::join_key_hints;

use super::state::FooterState;

pub fn render(frame: &mut Frame<'_>, area: Rect, state: &FooterState) {
    let left_width = area.width as usize / 2;
    let hints = join_key_hints(area.width as usize, &state.primary_hints());
    let mut text = state.status_text.clone();
    if text.chars().count() > left_width {
        text = text.chars().take(left_width.saturating_sub(1)).collect();
    }

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
        assert!(rendered.contains("Enter submit"));
    }
}
