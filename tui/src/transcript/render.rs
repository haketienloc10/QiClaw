use ratatui::prelude::*;
use ratatui::widgets::{Paragraph, Wrap};

use super::cell::TranscriptEntry;
use crate::protocol::TranscriptCellKind;

pub fn render(frame: &mut Frame<'_>, area: Rect, entries: &[TranscriptEntry], scroll: u16, spinner_frame: &str) {
    let rows = render_rows(entries, spinner_frame);
    for (row_index, line) in rows.into_iter().skip(scroll as usize).take(area.height as usize).enumerate() {
        let row_area = Rect {
            x: area.x,
            y: area.y.saturating_add(row_index as u16),
            width: area.width,
            height: 1,
        };
        frame.render_widget(Paragraph::new(line).wrap(Wrap { trim: false }), row_area);
    }
}

pub(super) fn render_rows(entries: &[TranscriptEntry], spinner_frame: &str) -> Vec<Line<'static>> {
    entries
        .iter()
        .flat_map(|entry| render_entry_lines(entry, spinner_frame))
        .collect()
}

pub(super) fn render_entry_lines(entry: &TranscriptEntry, spinner_frame: &str) -> Vec<Line<'static>> {
    match entry.kind {
        TranscriptCellKind::Tool => render_tool_entry_lines(entry, spinner_frame),
        _ => render_standard_entry_lines(entry),
    }
}

fn render_standard_entry_lines(entry: &TranscriptEntry) -> Vec<Line<'static>> {
    let header = header_text(entry);
    let mut lines = vec![Line::from(Span::styled(header, style_for_entry(entry)))];

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

    if separates_from_next_entry(entry) {
        lines.push(Line::default());
    }

    lines
}

fn render_tool_entry_lines(entry: &TranscriptEntry, spinner_frame: &str) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(Span::styled(
        tool_header(entry, spinner_frame),
        style_for_entry(entry),
    ))];

    let body = tool_body_lines(entry);
    if body.is_empty() {
        return lines;
    }

    for line in body {
        lines.push(Line::from(line));
    }

    lines
}

fn should_indent_body(entry: &TranscriptEntry) -> bool {
    matches!(entry.kind, TranscriptCellKind::User | TranscriptCellKind::Assistant)
}

pub(super) fn separates_from_next_entry(entry: &TranscriptEntry) -> bool {
    // Only primary conversation turns get extra trailing breathing room; work-log rows stay tighter.
    matches!(entry.kind, TranscriptCellKind::User | TranscriptCellKind::Assistant)
}

pub(super) fn body_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n')
}

fn header_text(entry: &TranscriptEntry) -> String {
    let marker = marker_for_entry(entry);
    match entry.kind {
        TranscriptCellKind::User => format!("{marker}"),
        TranscriptCellKind::Assistant if entry.streaming => format!("{marker} Working"),
        TranscriptCellKind::Assistant => format!("{marker}"),
        TranscriptCellKind::Status => format!("{marker} {}", entry.title.clone().unwrap_or_else(|| "Status".into())),
        TranscriptCellKind::Summary => format!("{marker} {}", entry.title.clone().unwrap_or_else(|| "Summary".into())),
        TranscriptCellKind::Diff => format!("{marker} Diff"),
        TranscriptCellKind::Shell => format!("{marker} Shell"),
        TranscriptCellKind::Tool => unreachable!("tool headers use tool_header"),
    }
}

fn marker_for_entry(entry: &TranscriptEntry) -> &'static str {
    match entry.kind {
        TranscriptCellKind::User => "›",
        TranscriptCellKind::Assistant => "•",
        TranscriptCellKind::Tool => "•",
        TranscriptCellKind::Status | TranscriptCellKind::Summary => "∙",
        TranscriptCellKind::Diff | TranscriptCellKind::Shell => "•",
    }
}

fn tool_header(entry: &TranscriptEntry, spinner_frame: &str) -> String {
    if entry.streaming {
        format!("{spinner_frame} {}", running_tool_label(entry))
    } else {
        let mut header = format!("• {}", completed_tool_label(entry));
        if entry.is_error {
            if let Some(duration) = extract_duration(entry) {
                header.push_str(&format!(" · {duration}"));
            }
        }
        header
    }
}

fn running_tool_label(entry: &TranscriptEntry) -> String {
    match entry.tool_name.as_deref() {
        Some("shell") => "Running shell command".into(),
        Some(name) if name.contains("search") || name.contains("grep") || name.contains("glob") => "Searching files".into(),
        Some(name) if name.contains("read") => "Read file".into(),
        Some(name) if name.contains("web") => "Searching the web".into(),
        Some(name) => humanize_tool_name(name),
        None => "Running tool".into(),
    }
}

fn completed_tool_label(entry: &TranscriptEntry) -> String {
    match entry.tool_name.as_deref() {
        Some("shell") => {
            let target = primary_target(entry.title.as_deref().unwrap_or_default());
            if target.is_empty() {
                "Ran shell command".into()
            } else {
                format!("Ran {target}")
            }
        }
        Some(name) if name.contains("search") || name.contains("grep") || name.contains("glob") => {
            let target = primary_target(entry.title.as_deref().unwrap_or_default());
            if target.is_empty() {
                "Searched files".into()
            } else {
                format!("Searched for \"{target}\"")
            }
        }
        Some(name) if name.contains("read") => "Read file".into(),
        Some(name) if name.contains("web") => {
            let target = primary_target(entry.title.as_deref().unwrap_or_default());
            if target.is_empty() {
                "Searched the web".into()
            } else {
                format!("Searched for \"{target}\"")
            }
        }
        Some(name) => humanize_tool_name(name),
        None => "Completed tool".into(),
    }
}

fn tool_body_lines(entry: &TranscriptEntry) -> Vec<String> {
    if entry.streaming {
        let target = primary_target(entry.title.as_deref().unwrap_or_default());
        if target.is_empty() {
            return Vec::new();
        }
        return vec![format!("  └ {target}")];
    }

    let preview = compact_tool_preview(entry.text.as_str(), entry.is_error);
    if preview.is_empty() {
        return Vec::new();
    }

    preview
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            if index == 0 {
                format!("  └ {line}")
            } else {
                format!("    {line}")
            }
        })
        .collect()
}

fn compact_tool_preview(text: &str, is_error: bool) -> Vec<String> {
    let raw_lines = body_lines(text)
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    if raw_lines.is_empty() {
        return Vec::new();
    }

    if is_error {
        return vec![format!("Error: {}", raw_lines[0])];
    }

    let mut lines = raw_lines.into_iter().take(2).collect::<Vec<_>>();
    let omitted = body_lines(text)
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .count()
        .saturating_sub(lines.len());

    if omitted > 0 {
        lines.push(format!("… +{omitted} lines (Ctrl+T to view transcript)"));
    }

    lines
}

fn primary_target(detail: &str) -> String {
    detail
        .split(" · ")
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn extract_duration(entry: &TranscriptEntry) -> Option<String> {
    entry.title.as_deref().and_then(|title| {
        title.split(" · ")
            .find(|part| part.trim_start().starts_with("failed in ") || part.trim_start().starts_with("completed in "))
            .and_then(|part| part.split_whitespace().last())
            .map(ToOwned::to_owned)
    })
}

fn humanize_tool_name(name: &str) -> String {
    let phrase = name.replace(['_', '-'], " ");
    let mut chars = phrase.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => "Running tool".into(),
    }
}

fn style_for_entry(entry: &TranscriptEntry) -> Style {
    if entry.is_error {
        return Style::default().fg(Color::Red).add_modifier(Modifier::BOLD);
    }
    match entry.kind {
        TranscriptCellKind::User => Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
        TranscriptCellKind::Assistant => Style::default().fg(Color::Cyan),
        TranscriptCellKind::Tool => {
            if entry.streaming {
                Style::default().fg(Color::LightBlue)
            } else {
                Style::default().fg(Color::Gray)
            }
        }
        TranscriptCellKind::Status | TranscriptCellKind::Summary => Style::default().fg(Color::DarkGray),
        TranscriptCellKind::Diff => Style::default().fg(Color::Blue),
        TranscriptCellKind::Shell => Style::default().fg(Color::LightMagenta),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::TranscriptCellKind;
    use ratatui::{backend::TestBackend, Terminal};

    const SPINNER: &str = "⠙";

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

        terminal
            .draw(|frame| render(frame, frame.area(), &entries, 0, SPINNER))
            .expect("draw");

        let buffer = terminal.backend().buffer();
        let rendered = (0..8)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("hello"));
        assert!(!rendered.contains("Transcript"));
    }

    #[test]
    fn renders_transcript_with_custom_row_pipeline() {
        let entry = TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git status".into()),
            text: "Running…".into(),
            tool_name: Some("shell".into()),
            is_error: false,
            streaming: true,
            turn_id: None,
            tool_call_id: None,
        };

        let rows = render_rows(&[entry], SPINNER);

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].to_string(), "⠙ Running shell command");
        assert_eq!(rows[1].to_string(), "  └ git status");
    }

    #[test]
    fn renders_streaming_tool_as_codex_like_activity_cell() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git status".into()),
            text: "Running…".into(),
            tool_name: Some("shell".into()),
            is_error: false,
            streaming: true,
            turn_id: None,
            tool_call_id: None,
        }, SPINNER);

        assert_eq!(lines[0].to_string(), "⠙ Running shell command");
        assert_eq!(lines[1].to_string(), "  └ git status");
    }

    #[test]
    fn renders_live_assistant_with_lightweight_working_label() {
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
        }, SPINNER);

        assert_eq!(lines[0].to_string(), "• Working");
        assert_eq!(lines[1].to_string(), "  Thinking through the diff");
    }

    #[test]
    fn renders_completed_tool_with_codex_like_preview() {
        let mut entry = TranscriptEntry::tool_running(
            "call-1".into(),
            "turn-1".into(),
            "shell".into(),
            "git status".into(),
        );
        entry.tool_completed(
            crate::protocol::ToolStatus::Success,
            "On branch main\nYour branch is up to date with 'origin/main'.\nChanges not staged for commit",
            None,
        );
        let lines = render_entry_lines(&entry, SPINNER);

        assert_eq!(lines[0].to_string(), "• Ran git status");
        assert_eq!(lines[1].to_string(), "  └ On branch main");
        assert_eq!(lines[2].to_string(), "    Your branch is up to date with 'origin/main'.");
        assert_eq!(lines[3].to_string(), "    … +1 lines (Ctrl+T to view transcript)");
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
        }, SPINNER);

        assert_eq!(lines[0].to_string(), "∙ Status");
        assert_eq!(lines[1].to_string(), "Indexing workspace");
    }

    #[test]
    fn renders_failed_tool_as_compact_error_preview() {
        let mut entry = TranscriptEntry::tool_running(
            "call-1".into(),
            "turn-1".into(),
            "shell".into(),
            "git status".into(),
        );
        entry.tool_completed(
            crate::protocol::ToolStatus::Error,
            "fatal: not a git repository",
            Some(28),
        );

        let lines = render_entry_lines(&entry, SPINNER);

        assert_eq!(lines[0].to_string(), "• Ran git status · 28ms");
        assert_eq!(lines[1].to_string(), "  └ Error: fatal: not a git repository");
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
        }, SPINNER);

        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered, vec!["•", "  a", "", "", ""]);
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
        }, SPINNER);
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
        }, SPINNER);
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
        }, SPINNER);
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
        }, SPINNER);

        assert_eq!(user[0].to_string(), "›");
        assert_eq!(assistant[0].to_string(), "•");
        assert_eq!(tool[0].to_string(), "• Ran git status");
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

        let lines = render_entry_lines(&entry, SPINNER);

        assert_eq!(lines[1].to_string(), "  └ On branch main");
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
        }, SPINNER);

        assert_eq!(lines[1].to_string(), "Indexing workspace");
    }

    #[test]
    fn keeps_tool_updates_tight_without_extra_separator_line() {
        let mut entry = TranscriptEntry::tool_running(
            "call-1".into(),
            "turn-1".into(),
            "shell".into(),
            "git status".into(),
        );
        entry.tool_completed(crate::protocol::ToolStatus::Success, "On branch main", None);

        let rendered = render_entry_lines(&entry, SPINNER)
            .iter()
            .map(Line::to_string)
            .collect::<Vec<_>>();

        assert_eq!(rendered, vec!["• Ran git status", "  └ On branch main"]);
    }

    #[test]
    fn keeps_status_updates_tight_without_extra_separator_line() {
        let rendered = render_entry_lines(&TranscriptEntry {
            id: "status-1".into(),
            kind: TranscriptCellKind::Status,
            title: Some("Status".into()),
            text: "Indexing workspace".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
        }, SPINNER)
        .iter()
        .map(Line::to_string)
        .collect::<Vec<_>>();

        assert_eq!(rendered, vec!["∙ Status", "Indexing workspace"]);
    }
}
