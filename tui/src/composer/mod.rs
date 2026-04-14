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

pub fn render(frame: &mut Frame<'_>, area: Rect, state: &ComposerState, catalog: &[SlashCatalogEntry]) {
    let title = match state.mode {
        ComposerMode::Shell => "Composer • shell",
        ComposerMode::Slash => "Composer • slash",
        ComposerMode::FileCompletion => "Composer • file",
        ComposerMode::HistorySearch => "Composer • history",
        ComposerMode::Normal => "Composer",
    };

    let paragraph = Paragraph::new(state.textarea.text.as_str())
        .block(Block::default().borders(Borders::ALL).title(title))
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);

    if let Some(warning) = &state.editor_warning {
        let warning_area = Rect {
            x: area.x.saturating_add(2),
            y: area.y.saturating_add(1),
            width: area.width.saturating_sub(4),
            height: 1,
        };
        frame.render_widget(Paragraph::new(warning.as_str()).style(Style::default().fg(Color::Yellow)), warning_area);
    }

    if state.popup.visible {
        let height = popup_height(state).max(1).saturating_add(2);
        let popup_area = Rect {
            x: area.x,
            y: area.y.saturating_sub(height.min(area.y)),
            width: area.width,
            height,
        };
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

    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title("Suggestions"))
        .highlight_style(Style::default().bg(Color::Blue).fg(Color::Black))
        .highlight_symbol("> ");
    let mut list_state = ratatui::widgets::ListState::default();
    list_state.select(Some(state.popup.selected));
    frame.render_stateful_widget(list, area, &mut list_state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{SlashCatalogEntry, SlashCatalogKind};
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
            .draw(|frame| render(frame, frame.area(), &state, &catalog))
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
        assert!(rendered.contains("Suggestions"));
    }
}
