mod app;
mod bridge;
mod composer;
mod footer;
mod protocol;
mod transcript;
mod widgets {
    pub mod key_hint;
    pub mod spinner;
}

use std::io;
use std::path::PathBuf;

use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use app::App;
use bridge::NdjsonBridge;

fn main() -> io::Result<()> {
    let bridge = NdjsonBridge::new()?;
    let mut stdout = io::stdout();
    enable_raw_mode()?;
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;

    let result = run_app(&mut terminal, bridge);

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

fn run_app(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    bridge: NdjsonBridge,
) -> io::Result<()> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut app = App::new(bridge, cwd);
    app.run(terminal)
}
