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
        let indent_body = should_indent_body(entry);
        for line in body_lines(&entry.text) {
            let rendered = if indent_body && !line.is_empty() {
                format!("  {line}")
            } else {
                line.to_string()
            };
            lines.push(Line::from(rendered));
        }
    }
    lines.push(Line::default());
    lines
}

fn should_indent_body(entry: &TranscriptEntry) -> bool {
    matches!(
        entry.kind,
        crate::protocol::TranscriptCellKind::User
            | crate::protocol::TranscriptCellKind::Assistant
            | crate::protocol::TranscriptCellKind::Tool
    )
}

pub(super) fn body_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n')
}

fn header_line(label: &str, detail: Option<&str>, entry: &TranscriptEntry) -> Line<'static> {
    let filtered_detail = detail
        .filter(|value| !value.is_empty())
        .filter(|value| *value != label);
    let marker = marker_for_entry(entry);

    let header = match filtered_detail {
        Some(detail) if label == "Tool" => format!("{marker} {label} {detail}"),
        Some(detail) => format!("{marker} {label} · {detail}"),
        None => format!("{marker} {label}"),
    };
    Line::from(Span::styled(header, style_for_entry(entry)))
}

fn marker_for_entry(entry: &TranscriptEntry) -> &'static str {
    match entry.kind {
        crate::protocol::TranscriptCellKind::User => "›",
        crate::protocol::TranscriptCellKind::Assistant => "✦",
        crate::protocol::TranscriptCellKind::Tool => "●",
        crate::protocol::TranscriptCellKind::Status | crate::protocol::TranscriptCellKind::Summary => "∙",
        crate::protocol::TranscriptCellKind::Diff | crate::protocol::TranscriptCellKind::Shell => "•",
    }
}

fn label_for_entry(entry: &TranscriptEntry) -> &'static str {
    match entry.kind {
        crate::protocol::TranscriptCellKind::User => "User",
        crate::protocol::TranscriptCellKind::Assistant => "Assistant",
        crate::protocol::TranscriptCellKind::Tool => "Tool",
        crate::protocol::TranscriptCellKind::Status => "Status",
        crate::protocol::TranscriptCellKind::Diff => "Diff",
        crate::protocol::TranscriptCellKind::Shell => "Shell",
        crate::protocol::TranscriptCellKind::Summary => "Summary",
    }
}

fn detail_for_entry(entry: &TranscriptEntry) -> Option<String> {
    match entry.kind {
        crate::protocol::TranscriptCellKind::Assistant if entry.streaming => Some("working".into()),
        crate::protocol::TranscriptCellKind::Tool => {
            let detail = entry
                .title
                .clone()
                .or_else(|| entry.tool_name.clone())
                .unwrap_or_default();
            if detail.is_empty() {
                return None;
            }
            if entry.streaming {
                return Some(format!("{detail} · running"));
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

        assert_eq!(lines[0].to_string(), "● Tool cargo_test · running");
        assert_eq!(lines[1].to_string(), "  Running…");
    }

    #[test]
    fn renders_live_assistant_with_working_label() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "assistant-1".into(),
            kind: TranscriptCellKind::Assistant,
            title: Some("Assistant".into()),
            text: "Thinking through the diff".into(),
            tool_name: None,
            is_error: false,
            streaming: true,
            turn_id: Some("turn-1".into()),
            tool_call_id: None,
        });

        assert_eq!(lines[0].to_string(), "✦ Assistant · working");
        assert_eq!(lines[1].to_string(), "  Thinking through the diff");
    }

    #[test]
    fn renders_completed_tool_with_status_and_duration_in_header() {
        let mut entry = TranscriptEntry::tool_running(
            "call-1".into(),
            "turn-1".into(),
            "shell".into(),
            "git status".into(),
        );
        entry.tool_completed(crate::protocol::ToolStatus::Success, "On branch main", None);
        let lines = render_entry_lines(&entry);

        assert_eq!(lines[0].to_string(), "● Tool git status · completed");
        assert_eq!(lines[1].to_string(), "  On branch main");
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

        assert_eq!(lines[0].to_string(), "∙ Status");
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
        assert_eq!(rendered, vec!["✦ Assistant", "  a", "", "", ""]);
    }

    #[test]
    fn uses_distinct_header_markers_by_entry_kind() {
        let user = render_entry_lines(&TranscriptEntry {
            id: "user-1".into(),
            kind: TranscriptCellKind::User,
            title: Some("User".into()),
            text: "hello".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
        });
        let assistant = render_entry_lines(&TranscriptEntry {
            id: "assistant-1".into(),
            kind: TranscriptCellKind::Assistant,
            title: Some("Assistant".into()),
            text: "thinking".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
        });
        let tool = render_entry_lines(&TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git status · completed".into()),
            text: "ok".into(),
            tool_name: Some("shell".into()),
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
        });
        let status = render_entry_lines(&TranscriptEntry {
            id: "status-1".into(),
            kind: TranscriptCellKind::Status,
            title: Some("Status".into()),
            text: "Indexing workspace".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
        });

        assert_eq!(user[0].to_string(), "› User");
        assert_eq!(assistant[0].to_string(), "✦ Assistant");
        assert_eq!(tool[0].to_string(), "● Tool git status · completed");
        assert_eq!(status[0].to_string(), "∙ Status");
    }

    #[test]
    fn indents_tool_result_body_lines_for_block_style_rendering() {
        let mut entry = TranscriptEntry::tool_running(
            "call-1".into(),
            "turn-1".into(),
            "shell".into(),
            "git status".into(),
        );
        entry.tool_completed(crate::protocol::ToolStatus::Success, "On branch main", None);

        let lines = render_entry_lines(&entry);

        assert_eq!(lines[1].to_string(), "  On branch main");
    }

    #[test]
    fn keeps_status_body_unindented_for_lightweight_system_messages() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "status-1".into(),
            kind: TranscriptCellKind::Status,
            title: Some("Status".into()),
            text: "Indexing workspace".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
        });

        assert_eq!(lines[1].to_string(), "Indexing workspace");
    }
}
