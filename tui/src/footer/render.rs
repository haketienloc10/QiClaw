use ratatui::prelude::*;
use ratatui::widgets::Paragraph;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::widgets::key_hint::join_key_hints;

use super::state::FooterState;

pub fn render_status_strip(frame: &mut Frame<'_>, area: Rect, state: &FooterState) {
    let model = state.model_text.as_str();
    let left_source = state.turn_summary_text.as_deref().unwrap_or(&state.status_text);
    let width = area.width as usize;

    let rendered = if model.is_empty() || width == 0 {
        truncate(left_source, width)
    } else {
        let model_width = display_width(model);
        if model_width >= width {
            let model_suffix = truncate_right(model, width);
            let padding = " ".repeat(width.saturating_sub(display_width(&model_suffix)));
            format!("{padding}{model_suffix}")
        } else {
            let gap = 1;
            let left_width = width.saturating_sub(model_width + gap);
            let left = truncate(left_source, left_width);
            let padding = " ".repeat(width.saturating_sub(display_width(&left) + model_width));
            format!("{left}{padding}{model}")
        }
    };

    let line = Line::from(Span::styled(rendered, Style::default().fg(Color::DarkGray)));
    frame.render_widget(Paragraph::new(line), area);
}

pub fn render_footer_rail(frame: &mut Frame<'_>, area: Rect, state: &FooterState) {
    let hints = join_key_hints(area.width as usize, &state.primary_hints());
    let line = Line::from(Span::styled(hints, Style::default().fg(Color::Gray)));
    frame.render_widget(Paragraph::new(line), area);
}

fn truncate(text: &str, max_width: usize) -> String {
    let mut rendered = String::new();
    let mut width = 0;

    for grapheme in text.graphemes(true) {
        let grapheme_width = display_width(grapheme);
        if width + grapheme_width > max_width {
            break;
        }
        rendered.push_str(grapheme);
        width += grapheme_width;
    }

    rendered
}

fn truncate_right(text: &str, max_width: usize) -> String {
    let mut kept = Vec::new();
    let mut width = 0;

    for grapheme in text.graphemes(true).rev() {
        let grapheme_width = display_width(grapheme);
        if width + grapheme_width > max_width {
            break;
        }
        kept.push(grapheme);
        width += grapheme_width;
    }

    kept.into_iter().rev().collect()
}

fn display_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
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
    fn status_strip_renders_turn_summary_on_left_and_model_on_right() {
        let state = FooterState {
            status_text: "Ready".into(),
            turn_summary_text: Some("completed • verified • 1 provider • 2 tools • 18s".into()),
            model_text: "anthropic:claude-sonnet-4-6".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(80, render_status_strip, &state);

        assert!(rendered.contains("completed • verified"));
        assert!(rendered.contains("anthropic:claude-sonnet-4-6"));
        assert!(rendered.trim_end().ends_with("anthropic:claude-sonnet-4-6"));
    }

    #[test]
    fn status_strip_falls_back_to_status_text_when_no_turn_summary_exists() {
        let state = FooterState {
            status_text: "Session restored".into(),
            model_text: "openai:gpt-test".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(48, render_status_strip, &state);

        assert!(rendered.contains("Session restored"));
        assert!(rendered.contains("openai:gpt-test"));
    }

    #[test]
    fn status_strip_truncates_left_side_before_model() {
        let state = FooterState {
            status_text: "Ready".into(),
            turn_summary_text: Some("completed • verified • 1 provider • 2 tools • 18s".into()),
            model_text: "anthropic:claude-sonnet-4-6".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(36, render_status_strip, &state);

        assert_eq!(rendered, "complete anthropic:claude-sonnet-4-6");
    }

    #[test]
    fn status_strip_preserves_right_side_of_model_when_width_is_less_than_model_width() {
        let state = FooterState {
            status_text: "Ready".into(),
            turn_summary_text: Some("completed • verified • 1 provider • 2 tools • 18s".into()),
            model_text: "anthropic:claude-sonnet-4-6".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(26, render_status_strip, &state);

        assert_eq!(rendered, "nthropic:claude-sonnet-4-6");
    }

    #[test]
    fn status_strip_preserves_full_model_when_width_matches_model_width() {
        let state = FooterState {
            status_text: "Ready".into(),
            turn_summary_text: Some("completed • verified • 1 provider • 2 tools • 18s".into()),
            model_text: "anthropic:claude-sonnet-4-6".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(27, render_status_strip, &state);

        assert_eq!(rendered, "anthropic:claude-sonnet-4-6");
    }

    #[test]
    fn status_strip_truncates_left_text_first_when_width_exceeds_model_width_by_one() {
        let state = FooterState {
            status_text: "Ready".into(),
            turn_summary_text: Some("completed • verified • 1 provider • 2 tools • 18s".into()),
            model_text: "anthropic:claude-sonnet-4-6".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(28, render_status_strip, &state);

        assert_eq!(rendered, " anthropic:claude-sonnet-4-6");
    }

    #[test]
    fn status_strip_uses_display_width_for_wide_unicode_and_preserves_model_suffix() {
        let state = FooterState {
            status_text: "Ready".into(),
            turn_summary_text: Some("wide界wide界wide".into()),
            model_text: "m界odel".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(9, render_status_strip, &state);

        assert_eq!(rendered, "w m界 odel");
        assert_eq!(rendered.chars().count(), 9);
    }

    #[test]
    fn status_strip_left_pads_truncated_model_suffix_to_keep_right_alignment() {
        let state = FooterState {
            status_text: "Ready".into(),
            model_text: "界a".into(),
            ..FooterState::default()
        };

        let rendered = rendered_line(2, render_status_strip, &state);

        assert_eq!(rendered, " a");
    }

    #[test]
    fn truncate_helpers_do_not_split_combining_mark_graphemes() {
        let grapheme = "e\u{301}";

        assert_eq!(truncate(grapheme, 1), grapheme);
        assert_eq!(truncate_right(grapheme, 1), grapheme);
    }

    #[test]
    fn truncate_helpers_do_not_split_zwj_emoji_graphemes() {
        let grapheme = "👩‍💻";

        assert_eq!(truncate(grapheme, 2), grapheme);
        assert_eq!(truncate_right(grapheme, 2), grapheme);
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
