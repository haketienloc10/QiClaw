use ratatui::prelude::*;
use ratatui::widgets::{Clear, Paragraph};

use super::cell::TranscriptEntry;
use crate::protocol::TranscriptCellKind;

pub fn render(frame: &mut Frame<'_>, area: Rect, entries: &[TranscriptEntry], scroll: u16, spinner_frame: &str) {
    frame.render_widget(Clear, area);

    let rows = render_rows(entries, spinner_frame, area.width);
    for (row_index, line) in rows.into_iter().skip(scroll as usize).take(area.height as usize).enumerate() {
        let row_area = Rect {
            x: area.x,
            y: area.y.saturating_add(row_index as u16),
            width: area.width,
            height: 1,
        };
        frame.render_widget(Paragraph::new(line), row_area);
    }
}

pub(super) fn render_rows(entries: &[TranscriptEntry], spinner_frame: &str, width: u16) -> Vec<Line<'static>> {
    entries
        .iter()
        .flat_map(|entry| render_entry_lines(entry, spinner_frame, width))
        .collect()
}

pub(super) fn render_entry_lines(entry: &TranscriptEntry, spinner_frame: &str, width: u16) -> Vec<Line<'static>> {
    if should_skip_entry(entry) {
        return Vec::new();
    }

    match entry.kind {
        TranscriptCellKind::Tool => render_tool_entry_lines(entry, spinner_frame, width),
        _ => render_standard_entry_lines(entry, width),
    }
}

fn should_skip_entry(entry: &TranscriptEntry) -> bool {
    matches!(entry.kind, TranscriptCellKind::Assistant)
        && !entry.streaming
        && entry.text.trim().is_empty()
}

fn render_inline_standard_entry(entry: &TranscriptEntry, width: u16) -> Option<Line<'static>> {
    if entry.text.contains('\n') || entry.text.trim().is_empty() {
        return None;
    }

    let inline_header = inline_header_text(entry);
    let inline_text = format!("{} {}", inline_header, entry.text);
    if inline_text.chars().count() > width.max(1) as usize {
        return None;
    }

    match entry.kind {
        TranscriptCellKind::User | TranscriptCellKind::Assistant => Some(Line::from(vec![
            Span::styled(inline_header, style_for_entry(entry)),
            Span::raw(" "),
            Span::raw(entry.text.clone()),
        ])),
        _ => None,
    }
}

fn render_standard_entry_lines(entry: &TranscriptEntry, width: u16) -> Vec<Line<'static>> {
    if let Some(inline) = render_inline_standard_entry(entry, width) {
        let mut lines = vec![inline];
        if separates_from_next_entry(entry) {
            lines.push(Line::default());
        }
        return lines;
    }

    let header = header_text(entry);
    let mut lines = vec![Line::from(Span::styled(header, style_for_entry(entry)))];

    if entry.text.is_empty() {
        lines.push(Line::default());
    } else {
        let indent_body = should_indent_body(entry);
        let wrapped_body_lines = wrap_standard_body_lines(&entry.text, indent_body, width);
        lines.extend(wrapped_body_lines.into_iter().map(Line::from));
    }

    if separates_from_next_entry(entry) {
        lines.push(Line::default());
    }

    lines
}

fn render_tool_entry_lines(entry: &TranscriptEntry, spinner_frame: &str, width: u16) -> Vec<Line<'static>> {
    let model = normalize_tool_display(entry, spinner_frame);
    let mut lines = vec![Line::from(Span::styled(model.header.clone(), style_for_entry(entry)))];

    let preview_lines = build_tool_preview_lines(&model);
    let wrapped = wrap_preview_lines(&preview_lines, width);
    lines.extend(render_tool_cell_lines(&wrapped));

    lines
}

fn wrap_standard_body_lines(text: &str, indent_body: bool, width: u16) -> Vec<String> {
    let prefix = if indent_body { "  " } else { "" };
    let available_width = (width as usize)
        .saturating_sub(prefix.chars().count())
        .max(1);
    let continuation_prefix = prefix;

    body_lines(text)
        .flat_map(|line| {
            if line.is_empty() {
                return vec![String::new()];
            }

            wrap_text_segments(line, available_width)
                .into_iter()
                .map(|segment| format!("{continuation_prefix}{segment}"))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn should_indent_body(entry: &TranscriptEntry) -> bool {
    matches!(entry.kind, TranscriptCellKind::User | TranscriptCellKind::Assistant)
}

pub(super) fn separates_from_next_entry(entry: &TranscriptEntry) -> bool {
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
        TranscriptCellKind::Tool => unreachable!("tool headers use tool display model"),
    }
}

fn inline_header_text(entry: &TranscriptEntry) -> String {
    let marker = marker_for_entry(entry);
    match entry.kind {
        TranscriptCellKind::User | TranscriptCellKind::Assistant => marker.to_string(),
        _ => header_text(entry),
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolDisplayModel {
    header: String,
    preview_lines: Vec<String>,
    truncated_line_count: usize,
}

fn normalize_tool_display(entry: &TranscriptEntry, spinner_frame: &str) -> ToolDisplayModel {
    if entry.streaming {
        let subject = running_tool_subject(entry);
        let target = normalize_tool_target(entry.title.as_deref().unwrap_or_default());
        let preview_lines = if !target.is_empty() && !subject.contains(&target) {
            vec![target]
        } else {
            Vec::new()
        };
        return ToolDisplayModel {
            header: format!("{spinner_frame} {subject}"),
            preview_lines,
            truncated_line_count: 0,
        };
    }

    let normalized = normalize_tool_output(entry.text.as_str());
    let header = completed_tool_header(entry);
    let mut preview_lines = format_tool_preview(entry, &normalized);
    let truncated_line_count = preview_lines
        .last()
        .and_then(|line| parse_truncation_line_count(line))
        .unwrap_or(0);

    if preview_lines.is_empty() {
        preview_lines.push(if entry.is_error {
            compact_error_summary(entry)
        } else {
            "no output".into()
        });
    }

    ToolDisplayModel {
        header,
        preview_lines,
        truncated_line_count,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NormalizedToolOutput {
    lines: Vec<String>,
}

fn normalize_tool_output(text: &str) -> NormalizedToolOutput {
    let unwrapped = unwrap_nested_tool_payload(text).unwrap_or_else(|| text.to_string());
    let normalized_newlines = unwrapped.replace("\\r\\n", "\n").replace("\\n", "\n");
    let lines = normalized_newlines
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect::<Vec<_>>();

    NormalizedToolOutput { lines }
}

fn unwrap_nested_tool_payload(text: &str) -> Option<String> {
    let parsed = serde_json::from_str::<serde_json::Value>(text).ok()?;
    extract_human_text_from_json(&parsed)
}

fn extract_human_text_from_json(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            if let Some(unwrapped) = unwrap_nested_tool_payload(text) {
                return Some(unwrapped);
            }
            Some(text.clone())
        }
        serde_json::Value::Object(map) => {
            for key in ["content", "stdout", "stderr", "result", "error", "message"] {
                if let Some(candidate) = map.get(key).and_then(extract_human_text_from_json) {
                    if !candidate.trim().is_empty() {
                        return Some(candidate);
                    }
                }
            }
            if let Some(data) = map.get("data") {
                if let Some(candidate) = extract_human_text_from_data(data) {
                    if !candidate.trim().is_empty() {
                        return Some(candidate);
                    }
                }
            }
            None
        }
        serde_json::Value::Array(items) => {
            let collected = items
                .iter()
                .filter_map(extract_human_text_from_json)
                .filter(|entry| !entry.trim().is_empty())
                .collect::<Vec<_>>();
            if collected.is_empty() {
                None
            } else {
                Some(collected.join("\n"))
            }
        }
        _ => None,
    }
}

fn format_tool_preview(entry: &TranscriptEntry, normalized: &NormalizedToolOutput) -> Vec<String> {
    if entry.is_error {
        return vec![compact_error_summary_with_duration(entry, normalized.lines.first().map(String::as_str).unwrap_or("unknown error"))];
    }

    if normalized.lines.is_empty() {
        return vec![structured_result_summary(entry)];
    }

    let title = normalize_tool_target(entry.title.as_deref().unwrap_or_default());
    let visible_lines = if let Some((first, rest)) = normalized.lines.split_first() {
        if !title.is_empty() && first == &title {
            rest
        } else {
            normalized.lines.as_slice()
        }
    } else {
        normalized.lines.as_slice()
    };

    if visible_lines.is_empty() {
        return vec![structured_result_summary(entry)];
    }

    let mut lines = visible_lines.iter().take(2).cloned().collect::<Vec<_>>();
    let omitted = visible_lines.len().saturating_sub(lines.len());
    if omitted > 0 {
        lines.push(format!("… +{omitted} lines (Ctrl+T to view transcript)"));
    }
    lines
}

fn build_tool_preview_lines(model: &ToolDisplayModel) -> Vec<String> {
    if model.preview_lines.is_empty() {
        return Vec::new();
    }
    model.preview_lines.clone()
}

fn wrap_preview_lines(lines: &[String], width: u16) -> Vec<String> {
    let available_width = width.max(8) as usize;
    let first_prefix = "  └ ";
    let continuation_prefix = "    ";
    let first_width = available_width.saturating_sub(first_prefix.chars().count()).max(1);
    let continuation_width = available_width.saturating_sub(continuation_prefix.chars().count()).max(1);

    let mut wrapped = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let prefix = if index == 0 { first_prefix } else { continuation_prefix };
        let line_width = if index == 0 { first_width } else { continuation_width };
        let segments = wrap_text_segments(line, line_width);
        if segments.is_empty() {
            wrapped.push(prefix.to_string());
            continue;
        }
        for (segment_index, segment) in segments.into_iter().enumerate() {
            let current_prefix = if index == 0 && segment_index == 0 {
                first_prefix
            } else {
                continuation_prefix
            };
            wrapped.push(format!("{current_prefix}{segment}"));
        }
    }
    wrapped
}

fn wrap_text_segments(text: &str, width: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }

    let mut segments = Vec::new();
    let mut current = String::new();

    for word in text.split_whitespace() {
        if current.is_empty() {
            if word.chars().count() <= width {
                current.push_str(word);
            } else {
                segments.extend(force_wrap_word(word, width));
            }
            continue;
        }

        let candidate_len = current.chars().count() + 1 + word.chars().count();
        if candidate_len <= width {
            current.push(' ');
            current.push_str(word);
            continue;
        }

        segments.push(current);
        current = String::new();
        if word.chars().count() <= width {
            current.push_str(word);
        } else {
            let mut forced = force_wrap_word(word, width);
            if let Some(last) = forced.pop() {
                segments.extend(forced);
                current = last;
            }
        }
    }

    if !current.is_empty() {
        segments.push(current);
    }

    if segments.is_empty() {
        vec![String::new()]
    } else {
        segments
    }
}

fn force_wrap_word(word: &str, width: usize) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    for ch in word.chars() {
        current.push(ch);
        if current.chars().count() >= width {
            result.push(current.clone());
            current.clear();
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

fn render_tool_cell_lines(lines: &[String]) -> Vec<Line<'static>> {
    lines.iter().cloned().map(Line::from).collect()
}

fn normalize_tool_target(detail: &str) -> String {
    detail
        .split(" · ")
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn running_tool_subject(entry: &TranscriptEntry) -> String {
    match entry.tool_name.as_deref() {
        Some("shell") | Some("git") => {
            let target = normalize_tool_target(entry.title.as_deref().unwrap_or_default());
            if target.is_empty() {
                "Running shell command".into()
            } else {
                format!("Running {target}")
            }
        }
        Some("read") | Some("read_file") => {
            let target = normalize_tool_target(entry.title.as_deref().unwrap_or_default());
            if target.is_empty() {
                "Reading file".into()
            } else {
                format!("Read {target}")
            }
        }
        Some(name) if name.contains("search") || name.contains("grep") || name.contains("glob") => "Searching files".into(),
        Some(name) => format!("Running {}", humanize_tool_name(name)),
        None => "Running tool".into(),
    }
}

fn completed_tool_header(entry: &TranscriptEntry) -> String {
    let title = normalize_tool_target(entry.title.as_deref().unwrap_or_default());
    let duration_suffix = if entry.is_error {
        entry.duration_ms.map(|ms| format!(" · {ms}ms")).unwrap_or_default()
    } else {
        String::new()
    };

    let label = match entry.tool_name.as_deref() {
        Some("shell") | Some("git") => {
            if title.is_empty() { "Ran shell command".into() } else { format!("Ran {title}") }
        }
        Some("read") | Some("read_file") => {
            if title.is_empty() { "Read file".into() } else { format!("Read {title}") }
        }
        Some(name) if name.contains("search") || name.contains("grep") || name.contains("glob") => {
            if title.is_empty() { "Searched files".into() } else { format!("Searched for \"{title}\"") }
        }
        Some(name) => {
            if title.is_empty() {
                humanize_tool_name(name)
            } else {
                format!("{} {title}", humanize_tool_name(name))
            }
        }
        None => {
            if title.is_empty() { "Completed tool".into() } else { title }
        }
    };

    format!("• {label}{duration_suffix}")
}

fn compact_success_summary(entry: &TranscriptEntry) -> String {
    match entry.tool_name.as_deref() {
        Some("git") => "no staged changes".into(),
        _ => "no output".into(),
    }
}

fn structured_result_summary(entry: &TranscriptEntry) -> String {
    match entry.tool_name.as_deref() {
        Some("git") => compact_success_summary(entry),
        _ => "structured result available".into(),
    }
}

fn extract_human_text_from_data(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            for key in ["stdout", "stderr", "content", "message", "result", "error"] {
                if let Some(candidate) = map.get(key).and_then(extract_human_text_from_json) {
                    if !candidate.trim().is_empty() {
                        return Some(candidate);
                    }
                }
            }
            None
        }
        _ => extract_human_text_from_json(value),
    }
}

fn compact_error_summary(entry: &TranscriptEntry) -> String {
    compact_error_summary_with_duration(entry, "unknown error")
}

fn compact_error_summary_with_duration(entry: &TranscriptEntry, message: &str) -> String {
    let duration = entry.duration_ms.map(|ms| format!(" · {ms}ms")).unwrap_or_default();
    format!("Error: {}{}", message.trim(), duration)
}

fn parse_truncation_line_count(line: &str) -> Option<usize> {
    let rest = line.strip_prefix("… +")?;
    let digits = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect::<String>();
    digits.parse::<usize>().ok()
}

fn humanize_tool_name(name: &str) -> String {
    let phrase = name.replace(['_', '-'], " ");
    let mut chars = phrase.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => "Tool".into(),
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
            duration_ms: None,
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
    fn clears_stale_transcript_rows_between_frames() {
        let backend = TestBackend::new(20, 4);
        let mut terminal = Terminal::new(backend).expect("terminal");

        terminal
            .draw(|frame| {
                render(
                    frame,
                    frame.area(),
                    &[TranscriptEntry {
                        id: "assistant-1".into(),
                        kind: TranscriptCellKind::Assistant,
                        title: Some("Assistant".into()),
                        text: "Chào Đại ca.".into(),
                        tool_name: None,
                        is_error: false,
                        streaming: false,
                        turn_id: Some("turn-1".into()),
                        tool_call_id: None,
                        duration_ms: None,
                    }],
                    0,
                    SPINNER,
                )
            })
            .expect("first draw");

        terminal
            .draw(|frame| {
                render(
                    frame,
                    frame.area(),
                    &[TranscriptEntry {
                        id: "assistant-1".into(),
                        kind: TranscriptCellKind::Assistant,
                        title: Some("Assistant".into()),
                        text: "Ch".into(),
                        tool_name: None,
                        is_error: false,
                        streaming: false,
                        turn_id: Some("turn-1".into()),
                        tool_call_id: None,
                        duration_ms: None,
                    }],
                    0,
                    SPINNER,
                )
            })
            .expect("second draw");

        let buffer = terminal.backend().buffer();
        let rendered = (0..4)
            .map(|y| {
                (0..20)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("• Ch"));
        assert!(!rendered.contains("Đại ca"));
    }

    #[test]
    fn clears_inline_fragment_when_completion_reflows_to_multiline() {
        let backend = TestBackend::new(18, 5);
        let mut terminal = Terminal::new(backend).expect("terminal");

        terminal
            .draw(|frame| {
                render(
                    frame,
                    frame.area(),
                    &[TranscriptEntry {
                        id: "assistant-1".into(),
                        kind: TranscriptCellKind::Assistant,
                        title: Some("Assistant".into()),
                        text: "Ch".into(),
                        tool_name: None,
                        is_error: false,
                        streaming: true,
                        turn_id: Some("turn-1".into()),
                        tool_call_id: None,
                        duration_ms: None,
                    }],
                    0,
                    SPINNER,
                )
            })
            .expect("first draw");

        terminal
            .draw(|frame| {
                render(
                    frame,
                    frame.area(),
                    &[TranscriptEntry {
                        id: "assistant-1".into(),
                        kind: TranscriptCellKind::Assistant,
                        title: Some("Assistant".into()),
                        text: "Chào Đại ca, em đây.".into(),
                        tool_name: None,
                        is_error: false,
                        streaming: false,
                        turn_id: Some("turn-1".into()),
                        tool_call_id: None,
                        duration_ms: None,
                    }],
                    0,
                    SPINNER,
                )
            })
            .expect("second draw");

        let buffer = terminal.backend().buffer();
        let rows = (0..5)
            .map(|y| {
                (0..18)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();

        assert_eq!(rows[0].trim_end(), "•");
        assert!(!rows[0].contains("Ch"));
        assert!(rows.iter().any(|row| row.contains("Chào Đại ca,")));
    }

    #[test]
    fn normalizes_nested_json_payload_into_human_preview() {
        let entry = TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git status".into()),
            text: r#"{"content":"{\"content\":\"On branch main\\nYour branch is clean\",\"data\":{\"command\":\"git\"}}"}"#.into(),
            tool_name: Some("git".into()),
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        };

        let lines = render_entry_lines(&entry, SPINNER, 80);
        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered[0], "• Ran git status");
        assert_eq!(rendered[1], "  └ On branch main");
        assert_eq!(rendered[2], "    Your branch is clean");
        assert!(!rendered.iter().any(|line| line.contains("{\"content\"")));
    }

    #[test]
    fn converts_escaped_newlines_into_logical_preview_lines() {
        let entry = TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git status".into()),
            text: "On branch main\\nChanges not staged for commit".into(),
            tool_name: Some("git".into()),
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        };

        let lines = render_entry_lines(&entry, SPINNER, 80);
        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered[1], "  └ On branch main");
        assert_eq!(rendered[2], "    Changes not staged for commit");
    }

    #[test]
    fn wraps_long_preview_lines_with_consistent_gutter_alignment() {
        let entry = TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git diff --stat".into()),
            text: "src/cli/tuiController.ts | 23 +++++++++++++++++++++++ tests/cli/tuiController.test.ts | 12 ++++++++".into(),
            tool_name: Some("git".into()),
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        };

        let lines = render_entry_lines(&entry, SPINNER, 40);
        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered[0], "• Ran git diff --stat");
        assert!(rendered[1].starts_with("  └ "));
        assert!(rendered[2].starts_with("    "));
        assert!(!rendered[2].starts_with("  └ "));
    }

    #[test]
    fn renders_running_tool_with_codex_like_gutter() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git diff --stat".into()),
            text: "Running…".into(),
            tool_name: Some("git".into()),
            is_error: false,
            streaming: true,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        }, SPINNER, 80);

        assert_eq!(lines[0].to_string(), "⠙ Running git diff --stat");
        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn does_not_repeat_command_in_completed_tool_header_and_preview() {
        let entry = TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git status --short".into()),
            text: "git status --short\nM src/main.rs".into(),
            tool_name: Some("git".into()),
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        };

        let lines = render_entry_lines(&entry, SPINNER, 80);
        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered[0], "• Ran git status --short");
        assert_eq!(rendered[1], "  └ M src/main.rs");
        assert!(!rendered.iter().any(|line| line == "  └ git status --short"));
    }

    #[test]
    fn does_not_repeat_read_file_target_in_header_and_preview() {
        let entry = TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("src/main.rs".into()),
            text: "src/main.rs\nfn main() {}".into(),
            tool_name: Some("read_file".into()),
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        };

        let lines = render_entry_lines(&entry, SPINNER, 80);
        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered[0], "• Read src/main.rs");
        assert_eq!(rendered[1], "  └ fn main() {}");
        assert!(!rendered.iter().any(|line| line == "  └ src/main.rs"));
    }

    #[test]
    fn does_not_repeat_search_target_in_header_and_preview() {
        let entry = TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("assistant_response in src/agent/loop.ts".into()),
            text: "assistant_response in src/agent/loop.ts\n42: const assistant_response = ...".into(),
            tool_name: Some("grep".into()),
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        };

        let lines = render_entry_lines(&entry, SPINNER, 100);
        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered[0], "• Searched for \"assistant_response in src/agent/loop.ts\"");
        assert_eq!(rendered[1], "  └ 42: const assistant_response = ...");
        assert!(!rendered.iter().any(|line| line == "  └ assistant_response in src/agent/loop.ts"));
    }

    #[test]
    fn renders_success_with_truncation_indicator() {
        let entry = TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git status".into()),
            text: "line 1\nline 2\nline 3\nline 4".into(),
            tool_name: Some("git".into()),
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        };

        let lines = render_entry_lines(&entry, SPINNER, 80);
        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered[1], "  └ line 1");
        assert_eq!(rendered[2], "    line 2");
        assert_eq!(rendered[3], "    … +2 lines (Ctrl+T to view transcript)");
    }

    #[test]
    fn renders_failure_with_compact_error_line() {
        let entry = TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git status".into()),
            text: "fatal: not a git repository".into(),
            tool_name: Some("git".into()),
            is_error: true,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: Some(28),
        };

        let lines = render_entry_lines(&entry, SPINNER, 80);
        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered[0], "• Ran git status · 28ms");
        assert_eq!(rendered[1], "  └ Error: fatal: not a git repository · 28ms");
    }

    #[test]
    fn renders_no_meaningful_output_compactly() {
        let entry = TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git diff --cached --stat".into()),
            text: "   \n\n  ".into(),
            tool_name: Some("git".into()),
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        };

        let lines = render_entry_lines(&entry, SPINNER, 80);
        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered[0], "• Ran git diff --cached --stat");
        assert_eq!(rendered[1], "  └ no staged changes");
    }

    #[test]
    fn uses_meaningful_command_title_instead_of_generic_tool_name() {
        let entry = TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git diff --stat".into()),
            text: "src/main.rs | 1 +".into(),
            tool_name: Some("git".into()),
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        };

        let lines = render_entry_lines(&entry, SPINNER, 80);
        assert_eq!(lines[0].to_string(), "• Ran git diff --stat");
        assert_ne!(lines[0].to_string(), "• Git");
    }

    #[test]
    fn renders_short_streaming_assistant_inline_to_avoid_orphaned_fragment() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "assistant-1".into(),
            kind: TranscriptCellKind::Assistant,
            title: Some("Assistant".into()),
            text: "Ch".into(),
            tool_name: None,
            is_error: false,
            streaming: true,
            turn_id: Some("turn-1".into()),
            tool_call_id: None,
            duration_ms: None,
        }, SPINNER, 80);

        assert_eq!(lines[0].to_string(), "• Ch");
        assert!(!lines.iter().any(|line| line.to_string().contains("Working")));
    }

    #[test]
    fn keeps_long_streaming_assistant_in_multiline_working_layout() {
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
            duration_ms: None,
        }, SPINNER, 12);

        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered[0], "• Working");
        assert_eq!(rendered[1], "  Thinking");
        assert!(rendered.iter().any(|line| line == "  through"));
    }

    #[test]
    fn renders_single_line_user_entry_inline() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "user-1".into(),
            kind: TranscriptCellKind::User,
            title: Some("User".into()),
            text: "review code dựa vào git diff".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        }, SPINNER, 80);

        assert_eq!(lines[0].to_string(), "› review code dựa vào git diff");
    }

    #[test]
    fn renders_single_line_assistant_entry_inline() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "assistant-1".into(),
            kind: TranscriptCellKind::Assistant,
            title: Some("Assistant".into()),
            text: "Đại ca, review nhanh theo git diff:".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: Some("turn-1".into()),
            tool_call_id: None,
            duration_ms: None,
        }, SPINNER, 80);

        assert_eq!(lines[0].to_string(), "• Đại ca, review nhanh theo git diff:");
    }

    #[test]
    fn long_single_line_assistant_entry_falls_back_to_multiline_layout() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "assistant-1".into(),
            kind: TranscriptCellKind::Assistant,
            title: Some("Assistant".into()),
            text: "Đây là một kết luận rất dài để buộc renderer phải xuống dòng thay vì inline cùng marker".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: Some("turn-1".into()),
            tool_call_id: None,
            duration_ms: None,
        }, SPINNER, 24);

        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert_eq!(rendered[0], "•");
        assert_eq!(rendered[1], "  Đây là một kết luận");
        assert!(rendered.len() > 3);
    }

    #[test]
    fn wraps_multiline_assistant_body_to_viewport_width() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "assistant-1".into(),
            kind: TranscriptCellKind::Assistant,
            title: Some("Assistant".into()),
            text: "Chuẩn, Đại ca. Lần này em đi quá sâu vào file nên chậm. Với task review diff thì nên bám git diff trước.".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: Some("turn-1".into()),
            tool_call_id: None,
            duration_ms: None,
        }, SPINNER, 28);

        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert!(rendered.len() > 3);
        assert_eq!(rendered[0], "•");
        assert!(rendered[1].starts_with("  Chuẩn, Đại ca."));
        assert!(rendered.iter().skip(1).all(|line| line.is_empty() || line.starts_with("  ")));
    }

    #[test]
    fn long_output_produces_full_row_count_without_losing_early_lines() {
        let text = (1..=20)
            .map(|index| format!("line {index}: đây là output dài để test scroll ổn định"))
            .collect::<Vec<_>>()
            .join("\n");
        let lines = render_entry_lines(&TranscriptEntry {
            id: "assistant-1".into(),
            kind: TranscriptCellKind::Assistant,
            title: Some("Assistant".into()),
            text,
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: Some("turn-1".into()),
            tool_call_id: None,
            duration_ms: None,
        }, SPINNER, 24);

        let rendered = lines.iter().map(Line::to_string).collect::<Vec<_>>();
        assert!(rendered.len() > 20);
        assert!(rendered.iter().any(|line| line.contains("line 1:")));
        assert!(rendered.iter().any(|line| line.contains("line 20:")));
    }

    #[test]
    fn does_not_render_empty_non_streaming_assistant_entry() {
        let lines = render_entry_lines(&TranscriptEntry {
            id: "assistant-1".into(),
            kind: TranscriptCellKind::Assistant,
            title: Some("Assistant".into()),
            text: "".into(),
            tool_name: None,
            is_error: false,
            streaming: false,
            turn_id: Some("turn-1".into()),
            tool_call_id: None,
            duration_ms: None,
        }, SPINNER, 80);

        assert!(lines.is_empty());
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
            duration_ms: None,
        }, SPINNER, 80);

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
            duration_ms: None,
        }, SPINNER, 80);

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
            duration_ms: None,
        }, SPINNER, 80);
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
            duration_ms: None,
        }, SPINNER, 80);
        let tool = render_entry_lines(&TranscriptEntry {
            id: "tool-1".into(),
            kind: TranscriptCellKind::Tool,
            title: Some("git status".into()),
            text: "ok".into(),
            tool_name: Some("git".into()),
            is_error: false,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
            duration_ms: None,
        }, SPINNER, 80);
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
            duration_ms: None,
        }, SPINNER, 80);

        assert_eq!(user[0].to_string(), "› hello");
        assert_eq!(assistant[0].to_string(), "• thinking");
        assert_eq!(tool[0].to_string(), "• Ran git status");
        assert_eq!(status[0].to_string(), "∙ Status");
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
            duration_ms: None,
        }, SPINNER, 80);

        assert_eq!(lines[1].to_string(), "Indexing workspace");
    }
}
