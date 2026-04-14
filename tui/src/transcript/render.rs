use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};

use super::cell::TranscriptEntry;

pub fn render(frame: &mut Frame<'_>, area: Rect, entries: &[TranscriptEntry], scroll: u16) {
    let text: Vec<Line> = entries.iter().flat_map(render_entry_lines).collect();
    let paragraph = Paragraph::new(text)
        .block(Block::default().borders(Borders::ALL).title("Transcript"))
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0));
    frame.render_widget(paragraph, area);
}

fn render_entry_lines(entry: &TranscriptEntry) -> Vec<Line<'static>> {
    let label = label_for_entry(entry);
    let detail = detail_for_entry(entry);
    let mut lines = vec![header_line(&label, detail.as_deref(), entry)];

    if entry.text.is_empty() {
        lines.push(Line::default());
    } else {
        for line in body_lines(&entry.text) {
            lines.push(Line::from(line.to_string()));
        }
    }
    lines.push(Line::default());
    lines
}

pub(super) fn body_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n')
}

fn header_line(label: &str, detail: Option<&str>, entry: &TranscriptEntry) -> Line<'static> {
    let mut spans = vec![Span::styled(format!("[{label}]"), style_for_entry(entry))];
    if let Some(detail) = detail.filter(|value| !value.is_empty()) {
        spans.push(Span::raw(" "));
        spans.push(Span::styled(detail.to_string(), detail_style(entry)));
    }
    Line::from(spans)
}

fn label_for_entry(entry: &TranscriptEntry) -> &'static str {
    match entry.kind {
        crate::protocol::TranscriptCellKind::User => "User",
        crate::protocol::TranscriptCellKind::Assistant => {
            if entry.streaming {
                "Assistant live"
            } else {
                "Assistant"
            }
        }
        crate::protocol::TranscriptCellKind::Tool => "Tool",
        crate::protocol::TranscriptCellKind::Status => "Status",
        crate::protocol::TranscriptCellKind::Diff => "Diff",
        crate::protocol::TranscriptCellKind::Shell => "Shell",
        crate::protocol::TranscriptCellKind::Summary => "Summary",
    }
}

fn detail_for_entry(entry: &TranscriptEntry) -> Option<String> {
    match entry.kind {
        crate::protocol::TranscriptCellKind::Tool => {
            let mut detail = entry
                .title
                .clone()
                .or_else(|| entry.tool_name.clone())
                .unwrap_or_default();
            if detail.is_empty() {
                return None;
            }
            if entry.streaming {
                detail.push_str(" (running)");
            }
            Some(detail)
        }
        crate::protocol::TranscriptCellKind::Status => entry.title.clone().filter(|title| !title.trim().is_empty()),
        _ => entry.title.clone().filter(|title| !title.trim().is_empty()),
    }
}

fn style_for_entry(entry: &TranscriptEntry) -> Style {
    if entry.is_error {
        return Style::default().fg(Color::Red).add_modifier(Modifier::BOLD);
    }
    match entry.kind {
        crate::protocol::TranscriptCellKind::User => Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
        crate::protocol::TranscriptCellKind::Assistant => Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        crate::protocol::TranscriptCellKind::Tool => Style::default().fg(Color::Magenta).add_modifier(Modifier::BOLD),
        crate::protocol::TranscriptCellKind::Status | crate::protocol::TranscriptCellKind::Summary => {
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
        }
        crate::protocol::TranscriptCellKind::Diff => Style::default().fg(Color::Blue).add_modifier(Modifier::BOLD),
        crate::protocol::TranscriptCellKind::Shell => {
            Style::default().fg(Color::LightMagenta).add_modifier(Modifier::BOLD)
        }
    }
}

fn detail_style(entry: &TranscriptEntry) -> Style {
    if entry.is_error {
        Style::default().fg(Color::Red)
    } else if entry.streaming {
        Style::default().fg(Color::Gray)
    } else {
        Style::default().fg(Color::White)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::TranscriptCellKind;
    use ratatui::{backend::TestBackend, Terminal};

    #[test]
    fn renders_entries_into_buffer() {
        let backend = TestBackend::new(40, 8);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let entries = vec![TranscriptEntry {
            id: "assistant-1".into(),
            kind: TranscriptCellKind::Assistant,
            title: Some("Assistant".into()),
            text: "hello".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
        }];

        terminal.draw(|frame| render(frame, frame.area(), &entries, 0)).expect("draw");

        let buffer = terminal.backend().buffer();
        let rendered = (0..8)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("Transcript"));
        assert!(rendered.contains("hello"));
    }

    #[test]
    fn omits_empty_title_line_and_shows_streaming_tool_label() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: None,
            text: "Running…".into(),
            tool_name: Some("cargo_test".into()),
            is_error: false,
            streaming: true,
            turn_id: None,
            tool_call_id: None,
        });

        assert_eq!(lines[0].to_string(), "[Tool] cargo_test (running)");
        assert_eq!(lines[1].to_string(), "Running…");
    }

    #[test]
    fn shows_status_title_without_blank_placeholder() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "status-1".into(),
            kind: TranscriptCellKind::Status,
            title: None,
            text: "Indexing workspace".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
        });

        assert_eq!(lines[0].to_string(), "[Status]");
        assert_eq!(lines[1].to_string(), "Indexing workspace");
    }

    #[test]
    fn preserves_trailing_blank_lines_in_entry_text() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "assistant-1".into(),
            kind: TranscriptCellKind::Assistant,
            title: Some("Assistant".into()),
            text: "a\n\n".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
        });

        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered, vec!["[Assistant] Assistant", "a", "", "", ""]);
    }
}
