pub mod command_popup;
pub mod file_completion;
pub mod history_search;
pub mod slash_commands;
pub mod state;
pub mod textarea;

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};

use crate::protocol::SlashCatalogEntry;

pub use state::{ComposerMode, ComposerState, SubmitAction};

pub fn popup_height(state: &ComposerState) -> u16 {
    match state.mode {
        ComposerMode::Slash => state.slash_matches.len().min(5) as u16,
        ComposerMode::FileCompletion => state.file_matches.len().min(5) as u16,
        ComposerMode::HistorySearch => state.history_search.matches.len().min(5) as u16,
        _ => 0,
    }
}

fn cursor_position(area: Rect, text: &str, cursor: usize) -> Position {
    let mut x = area.x;
    let mut y = area.y.saturating_add(1);

    for ch in text[..cursor].chars() {
        if ch == '\n' {
            x = area.x;
            y = y.saturating_add(1);
        } else {
            x = x.saturating_add(1);
        }
    }

    Position::new(x, y)
}

pub fn render(
    frame: &mut Frame<'_>,
    area: Rect,
    popup_area: Rect,
    state: &ComposerState,
    catalog: &[SlashCatalogEntry],
) {
    let title = match state.mode {
        ComposerMode::Shell => "Shell",
        ComposerMode::Slash => "Command",
        ComposerMode::FileCompletion => "Attach",
        ComposerMode::HistorySearch => "History",
        ComposerMode::Normal => "Ask",
    };
    let placeholder = match state.mode {
        ComposerMode::Shell => "Run a shell command",
        ComposerMode::Slash => "Type a command",
        ComposerMode::FileCompletion => "Attach a file",
        ComposerMode::HistorySearch => "Search history",
        ComposerMode::Normal => "Ask anything",
    };
    let is_empty = state.textarea.text.is_empty();

    let paragraph = if is_empty {
        Paragraph::new(Line::from(Span::styled(
            placeholder,
            Style::default().fg(Color::DarkGray),
        )))
        .block(Block::default().borders(Borders::TOP).title(title))
        .wrap(Wrap { trim: false })
    } else {
        Paragraph::new(state.textarea.text.as_str())
            .block(Block::default().borders(Borders::TOP).title(title))
            .wrap(Wrap { trim: false })
    };
    frame.render_widget(paragraph, area);

    let cursor = cursor_position(area, &state.textarea.text, state.textarea.cursor);
    frame.set_cursor_position(cursor);

    if let Some(warning) = &state.editor_warning {
        let warning_area = Rect {
            x: area.x.saturating_add(2),
            y: area.y.saturating_add(1),
            width: area.width.saturating_sub(4),
            height: 1,
        };
        frame.render_widget(Paragraph::new(warning.as_str()).style(Style::default().fg(Color::Yellow)), warning_area);
    }

    if state.popup.visible && popup_area.height > 0 {
        frame.render_widget(Clear, popup_area);
        render_popup(frame, popup_area, state, catalog);
    }
}

fn render_popup(frame: &mut Frame<'_>, area: Rect, state: &ComposerState, catalog: &[SlashCatalogEntry]) {
    let items: Vec<ListItem> = match state.mode {
        ComposerMode::Slash => state
            .slash_matches
            .iter()
            .map(|entry| ListItem::new(format!("{} — {}", entry.name, entry.description)))
            .collect(),
        ComposerMode::FileCompletion => state
            .file_matches
            .iter()
            .map(|entry| ListItem::new(entry.as_str()))
            .collect(),
        ComposerMode::HistorySearch => state
            .history_search
            .matches
            .iter()
            .map(|entry| ListItem::new(entry.text.as_str()))
            .collect(),
        ComposerMode::Normal | ComposerMode::Shell => {
            if state.textarea.text.trim() == "/help" {
                catalog
                    .iter()
                    .map(|entry| ListItem::new(format!("{} — {}", entry.name, entry.description)))
                    .collect()
            } else {
                Vec::new()
            }
        }
    };

    let popup_title = match state.mode {
        ComposerMode::Slash => "Commands",
        ComposerMode::FileCompletion => "Paths",
        ComposerMode::HistorySearch => "History",
        _ => "Suggestions",
    };

    let list = List::new(items)
        .block(Block::default().borders(Borders::TOP).title(popup_title))
        .highlight_style(Style::default().bg(Color::DarkGray).fg(Color::White))
        .highlight_symbol("• ");
    let mut list_state = ratatui::widgets::ListState::default();
    list_state.select(Some(state.popup.selected));
    frame.render_stateful_widget(list, area, &mut list_state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{SlashCatalogEntry, SlashCatalogKind};
    use crate::transcript::layout;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn renders_popup_basics_into_buffer() {
        let backend = TestBackend::new(40, 8);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let mut state = ComposerState::default();
        let catalog = vec![SlashCatalogEntry {
            name: "/status".into(),
            description: "Show status".into(),
            usage: Some("/status".into()),
            kind: SlashCatalogKind::Direct,
        }];
        state.textarea.set_text("/st".into());
        state.refresh_modes(&catalog, std::path::Path::new("."));

        terminal
            .draw(|frame| render(frame, frame.area(), frame.area(), &state, &catalog))
            .expect("draw");

        let buffer = terminal.backend().buffer().clone();
        let rendered_lines: Vec<String> = (0..8)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect();
        let rendered = rendered_lines.join("\n");
        assert!(rendered.contains("/status"));
        assert!(rendered.contains("Commands"));
    }

    #[test]
    fn renders_codex_like_composer_title_for_slash_mode() {
        let backend = TestBackend::new(40, 6);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let mut state = ComposerState::default();
        let catalog = vec![SlashCatalogEntry {
            name: "/status".into(),
            description: "Show status".into(),
            usage: Some("/status".into()),
            kind: SlashCatalogKind::Direct,
        }];
        state.textarea.set_text("/st".into());
        state.refresh_modes(&catalog, std::path::Path::new("."));
        state.popup.close();

        terminal
            .draw(|frame| render(frame, frame.area(), frame.area(), &state, &catalog))
            .expect("draw");

        let buffer = terminal.backend().buffer().clone();
        let rendered = (0..6)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("Command"));
        assert!(!rendered.contains("Prompt • slash"));
    }

    #[test]
    fn renders_placeholder_when_composer_is_empty() {
        let backend = TestBackend::new(40, 4);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let state = ComposerState::default();
        let catalog = Vec::new();

        terminal
            .draw(|frame| render(frame, frame.area(), Rect::default(), &state, &catalog))
            .expect("draw");

        let buffer = terminal.backend().buffer().clone();
        let rendered = (0..4)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("Ask anything"));
    }

    #[test]
    fn renders_contextual_popup_title_for_slash_mode() {
        let backend = TestBackend::new(40, 8);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let mut state = ComposerState::default();
        let catalog = vec![SlashCatalogEntry {
            name: "/status".into(),
            description: "Show status".into(),
            usage: Some("/status".into()),
            kind: SlashCatalogKind::Direct,
        }];
        state.textarea.set_text("/st".into());
        state.refresh_modes(&catalog, std::path::Path::new("."));

        terminal
            .draw(|frame| render(frame, frame.area(), frame.area(), &state, &catalog))
            .expect("draw");

        let buffer = terminal.backend().buffer().clone();
        let rendered = (0..8)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("Commands"));
        assert!(!rendered.contains("Suggestions"));
    }

    #[test]
    fn renders_shell_mode_with_lighter_top_only_shell() {
        let backend = TestBackend::new(40, 4);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let mut state = ComposerState::default();
        let catalog = Vec::new();
        state.textarea.set_text("!git status".into());
        state.refresh_modes(&catalog, std::path::Path::new("."));

        terminal
            .draw(|frame| render(frame, frame.area(), frame.area(), &state, &catalog))
            .expect("draw");

        let buffer = terminal.backend().buffer().clone();
        let rendered = (0..4)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("Shell"));
        assert!(!rendered.contains("│"));
        assert!(!rendered.contains("└"));
        assert!(!rendered.contains("┘"));
    }

    #[test]
    fn renders_popup_as_attached_overlay_above_composer() {
        let backend = TestBackend::new(40, 8);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let mut state = ComposerState::default();
        let catalog = vec![SlashCatalogEntry {
            name: "/status".into(),
            description: "Show status".into(),
            usage: Some("/status".into()),
            kind: SlashCatalogKind::Direct,
        }];
        state.textarea.set_text("/st".into());
        state.refresh_modes(&catalog, std::path::Path::new("."));

        terminal
            .draw(|frame| {
                let composer_area = Rect {
                    x: 0,
                    y: 5,
                    width: 40,
                    height: 3,
                };
                let popup_area = Rect {
                    x: 0,
                    y: 1,
                    width: 40,
                    height: 4,
                };
                render(frame, composer_area, popup_area, &state, &catalog);
            })
            .expect("draw");

        let buffer = terminal.backend().buffer().clone();
        let popup_rows = (1..=4)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();
        let rendered = (0..8)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(popup_rows.iter().any(|row| row.contains("/status")));
        assert!(!rendered.contains("└"));
        assert!(!rendered.contains("┘"));
    }

    #[test]
    fn renders_popup_using_layout_geometry_on_short_terminal() {
        let backend = TestBackend::new(40, 12);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let mut state = ComposerState::default();
        let catalog = vec![
            SlashCatalogEntry {
                name: "/status".into(),
                description: "Show status".into(),
                usage: Some("/status".into()),
                kind: SlashCatalogKind::Direct,
            },
            SlashCatalogEntry {
                name: "/start".into(),
                description: "Start session".into(),
                usage: Some("/start".into()),
                kind: SlashCatalogKind::Direct,
            },
            SlashCatalogEntry {
                name: "/stash".into(),
                description: "Stash changes".into(),
                usage: Some("/stash".into()),
                kind: SlashCatalogKind::Direct,
            },
            SlashCatalogEntry {
                name: "/stats".into(),
                description: "Show stats".into(),
                usage: Some("/stats".into()),
                kind: SlashCatalogKind::Direct,
            },
            SlashCatalogEntry {
                name: "/state".into(),
                description: "Show state".into(),
                usage: Some("/state".into()),
                kind: SlashCatalogKind::Direct,
            },
        ];
        state.textarea.set_text("/st".into());
        state.refresh_modes(&catalog, std::path::Path::new("."));

        terminal
            .draw(|frame| {
                let layout = layout::split_root(frame.area(), popup_height(&state));
                assert_eq!(layout.popup.y, layout.composer.y);
                assert_eq!(layout.popup.height, 3);
                render(frame, layout.composer, layout.popup, &state, &catalog);
            })
            .expect("draw");

        let buffer = terminal.backend().buffer().clone();
        let popup_top = (0..40)
            .map(|x| buffer[(x, 7)].symbol())
            .collect::<String>();
        let popup_rows = (7..=9)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();
        let above_popup = (0..40)
            .map(|x| buffer[(x, 6)].symbol())
            .collect::<String>();

        assert!(popup_top.contains("Commands"));
        assert!(popup_rows.iter().any(|row| row.contains("/start")));
        assert!(!above_popup.contains("Commands"));
        assert!(!above_popup.contains("/start"));
    }

    #[test]
    fn places_terminal_cursor_at_textarea_cursor_position() {
        let backend = TestBackend::new(40, 6);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let mut state = ComposerState::default();
        let catalog = Vec::new();
        state.textarea.set_text("hello".into());
        state.textarea.move_left();
        state.textarea.move_left();

        terminal
            .draw(|frame| render(frame, frame.area(), Rect::default(), &state, &catalog))
            .expect("draw");

        let cursor = terminal
            .backend_mut()
            .get_cursor_position()
            .expect("cursor position");
        assert_eq!(cursor, Position::new(3, 1));
    }
}
