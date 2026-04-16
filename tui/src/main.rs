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
use crossterm::event::{
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::terminal::supports_keyboard_enhancement;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use app::App;
use bridge::NdjsonBridge;

fn main() -> io::Result<()> {
    let bridge = NdjsonBridge::new()?;
    let mut stdout = io::stdout();
    let enhanced_keys_supported = supports_keyboard_enhancement().unwrap_or(false);
    enable_raw_mode()?;
    execute!(stdout, EnterAlternateScreen)?;
    if enhanced_keys_supported {
        let _ = execute!(
            stdout,
            PushKeyboardEnhancementFlags(
                KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                    | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                    | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
            )
        );
    }
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;

    let result = run_app(&mut terminal, bridge, enhanced_keys_supported);

    let _ = execute!(terminal.backend_mut(), PopKeyboardEnhancementFlags);
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

fn run_app(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    bridge: NdjsonBridge,
    enhanced_keys_supported: bool,
) -> io::Result<()> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut app = App::new(bridge, cwd, enhanced_keys_supported);
    app.run(terminal)
}
