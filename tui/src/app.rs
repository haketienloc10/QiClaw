use std::io;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::bridge::{ActionWriter, NdjsonBridge};
use crate::composer::{self, ComposerState, SubmitAction};
use crate::footer::FooterState;
use crate::protocol::{FrontendAction, HostEvent, SlashCatalogEntry, SlashCatalogKind};
use crate::transcript::{self, TranscriptState};
use crate::widgets::spinner::Spinner;

pub struct App {
    bridge: ActionWriter,
    rx: Receiver<HostEvent>,
    transcript: TranscriptState,
    composer: ComposerState,
    footer: FooterState,
    slash_catalog: Vec<SlashCatalogEntry>,
    cwd: PathBuf,
    spinner: Spinner,
    session_id: Option<String>,
    model: Option<String>,
    status_text: String,
    terminal_status_text: Option<String>,
    turn_summary_text: Option<String>,
    should_quit: bool,
}

impl App {
    pub fn new(bridge: NdjsonBridge, cwd: PathBuf, enhanced_keys_supported: bool) -> Self {
        let (mut reader, writer) = bridge.split();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || loop {
            match reader.read_event() {
                Ok(Some(event)) => {
                    if tx.send(event).is_err() {
                        break;
                    }
                }
                Ok(None) => {
                    break;
                }
                Err(error) => {
                    let _ = tx.send(HostEvent::Error {
                        text: format!("Bridge read error: {error}"),
                    });
                    break;
                }
            }
        });

        Self {
            bridge: writer,
            rx,
            transcript: TranscriptState::default(),
            composer: ComposerState::default(),
            footer: FooterState {
                shift_enter_supported: enhanced_keys_supported,
                ..FooterState::default()
            },
            slash_catalog: Vec::new(),
            cwd,
            spinner: Spinner::default(),
            session_id: None,
            model: None,
            status_text: "Ready".into(),
            terminal_status_text: None,
            turn_summary_text: None,
            should_quit: false,
        }
    }

    pub fn run(&mut self, terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>) -> io::Result<()> {
        let mut last_tick = Instant::now();
        self.update_footer();

        while !self.should_quit {
            loop {
                match self.rx.try_recv() {
                    Ok(event) => self.handle_host_event(event),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        self.should_quit = true;
                        break;
                    }
                }
            }

            if self.should_quit {
                break;
            }

            terminal.draw(|frame| {
                let layout = transcript::layout::split_root(frame.area(), composer::popup_height(&self.composer));
                transcript::render::render(
                    frame,
                    layout.transcript,
                    &self.transcript.entries,
                    self.transcript.render_scroll(
                        layout.transcript.height.saturating_sub(2),
                        layout.transcript.width,
                    ),
                    self.spinner.frame(),
                );
                crate::footer::render::render_status_strip(frame, layout.status, &self.footer);
                composer::render(frame, layout.composer, layout.popup, &self.composer, &self.slash_catalog);
                crate::footer::render::render_footer_rail(frame, layout.footer, &self.footer);
            })?;

            let timeout = Duration::from_millis(50);
            if event::poll(timeout)? {
                if let Event::Key(key) = event::read()? {
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }
                    self.handle_key_event(key)?;
                }
            }

            if last_tick.elapsed() >= Duration::from_millis(120) {
                self.spinner.tick();
                last_tick = Instant::now();
                self.update_footer();
            }
        }

        Ok(())
    }

    fn handle_host_event(&mut self, event: HostEvent) {
        if matches!(
            event,
            HostEvent::SessionLoaded { .. }
                | HostEvent::Status { .. }
                | HostEvent::Footer { .. }
                | HostEvent::Warning { .. }
                | HostEvent::Error { .. }
                | HostEvent::TurnCompleted { .. }
        ) {
            self.terminal_status_text = None;
        }

        match &event {
            HostEvent::Hello {
                session_id,
                model,
                cwd,
                ..
            } => {
                self.session_id = Some(session_id.clone());
                self.model = Some(model.clone());
                self.cwd = PathBuf::from(cwd);
            }
            HostEvent::SessionLoaded { restored, .. } => {
                self.status_text = if *restored {
                    "Session restored".into()
                } else {
                    "New session".into()
                };
            }
            HostEvent::SlashCatalog { commands } => {
                self.slash_catalog = commands.clone();
                self.composer.refresh_modes(&self.slash_catalog, &self.cwd);
            }
            HostEvent::FooterSummary { text } => {
                self.turn_summary_text = Some(text.clone());
            }
            HostEvent::Status { text } | HostEvent::Footer { text } | HostEvent::Warning { text } => {
                self.status_text = text.clone();
            }
            HostEvent::Error { text } => {
                self.status_text = text.clone();
                self.composer.set_busy(false);
            }
            HostEvent::TurnCompleted { .. } => {
                self.composer.set_busy(false);
            }
            HostEvent::AssistantCompleted { .. } => {}
            HostEvent::TranscriptSeed { .. }
            | HostEvent::TranscriptAppend { .. }
            | HostEvent::AssistantDelta { .. }
            | HostEvent::ToolStarted { .. }
            | HostEvent::ToolCompleted { .. } => {}
        }

        self.transcript.apply(&event);
        self.update_footer();
    }

    fn handle_key_event(&mut self, key: KeyEvent) -> io::Result<()> {
        match (key.modifiers, key.code) {
            (mods, KeyCode::Char('c')) if mods.contains(KeyModifiers::CONTROL) => {
                self.should_quit = true;
                let _ = self.bridge.send_action(&FrontendAction::Quit);
            }
            (mods, KeyCode::Char('j')) if mods.contains(KeyModifiers::CONTROL) => {
                self.composer.insert_newline();
            }
            (mods, KeyCode::Char('r')) if mods.contains(KeyModifiers::CONTROL) => {
                self.composer.start_history_search();
            }
            (mods, KeyCode::Char('g')) if mods.contains(KeyModifiers::CONTROL) => {
                self.composer.note_editor_unsupported();
                self.terminal_status_text = Some(
                    self.composer
                        .editor_warning
                        .clone()
                        .unwrap_or_else(|| "Editor mode unavailable".into()),
                );
            }
            (_, KeyCode::Esc) => {
                self.composer.escape();
            }
            (_, KeyCode::Tab) => {
                let _ = self.composer.accept_popup(&self.slash_catalog, &self.cwd);
            }
            (_, KeyCode::Up) => {
                if self.composer.popup.visible {
                    self.composer.move_popup_prev();
                } else {
                    self.transcript.scroll_up(1);
                }
            }
            (_, KeyCode::Down) => {
                if self.composer.popup.visible {
                    self.composer.move_popup_next();
                } else {
                    self.transcript.scroll_down(1);
                }
            }
            (_, KeyCode::PageUp) => self.transcript.scroll_up(5),
            (_, KeyCode::PageDown) => self.transcript.scroll_to_bottom(),
            (mods, KeyCode::Enter) if mods.contains(KeyModifiers::SHIFT) => {
                self.composer.insert_newline();
            }
            (_, KeyCode::Enter) => {
                if self.composer.popup.visible && self.composer.accept_popup(&self.slash_catalog, &self.cwd) {
                    self.update_footer();
                    return Ok(());
                }
                if let Some(submit) = self.composer.submit() {
                    self.dispatch_submit(submit.action)?;
                }
            }
            (_, KeyCode::Backspace) => {
                if self.composer.history_search.active {
                    let mut query = self.composer.history_search.query.clone();
                    query.pop();
                    self.composer.update_history_query(query);
                } else {
                    self.composer.backspace(&self.slash_catalog, &self.cwd);
                }
            }
            (_, KeyCode::Left) => self.composer.textarea.move_left(),
            (_, KeyCode::Right) => self.composer.textarea.move_right(),
            (_, KeyCode::Char(ch)) => {
                if self.composer.history_search.active {
                    let mut query = self.composer.history_search.query.clone();
                    query.push(ch);
                    self.composer.update_history_query(query);
                } else {
                    self.composer.insert_char(ch, &self.slash_catalog, &self.cwd);
                }
            }
            _ => {}
        }

        self.update_footer();
        Ok(())
    }

    fn dispatch_submit(&mut self, action: SubmitAction) -> io::Result<()> {
        let should_mark_busy = match &action {
            SubmitAction::Prompt(_) => true,
            SubmitAction::Slash { command, .. } => self
                .slash_catalog
                .iter()
                .find(|entry| entry.name == *command)
                .map(|entry| entry.kind == SlashCatalogKind::Prompt)
                .unwrap_or(false),
            SubmitAction::Shell { .. } => false,
        };
        let frontend = match action {
            SubmitAction::Prompt(prompt) => FrontendAction::SubmitPrompt { prompt },
            SubmitAction::Slash { command, args_text } => FrontendAction::RunSlashCommand { command, args_text },
            SubmitAction::Shell { command, args } => FrontendAction::RunShellCommand {
                command,
                args: if args.is_empty() { None } else { Some(args) },
            },
        };
        self.bridge.send_action(&frontend)?;
        self.composer.set_busy(should_mark_busy);
        self.update_footer();
        Ok(())
    }

    fn update_footer(&mut self) {
        self.footer.mode = self.composer.mode;
        self.footer.popup_open = self.composer.popup.visible;
        self.footer.draft_present = !self.composer.textarea.is_empty();
        self.footer.busy = self.composer.busy;
        self.footer.transcript_scrolled = !self.transcript.is_auto_following();
        self.footer.turn_summary_text = self.turn_summary_text.clone();
        self.footer.model_text = self.model.clone().unwrap_or_default();

        let mut status_text = if self.status_text.trim().is_empty() {
            "Ready".into()
        } else {
            self.status_text.clone()
        };

        if let Some(terminal_status_text) = self.terminal_status_text.clone() {
            status_text = terminal_status_text;
        }

        if self.footer.transcript_scrolled {
            status_text = "Scrolled".into();
        } else if self.footer.busy {
            let model = self.model.clone().unwrap_or_else(|| "agent".into());
            status_text = format!("{} Working · {model}", self.spinner.frame());
        }

        self.footer.status_text = status_text;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::os::fd::IntoRawFd;
    use tempfile::NamedTempFile;

    fn test_app() -> App {
        let reader = NamedTempFile::new().expect("reader temp file");
        let writer = NamedTempFile::new().expect("writer temp file");
        let bridge = NdjsonBridge::from_fds(
            File::open(reader.path()).expect("open reader").into_raw_fd(),
            File::create(writer.path()).expect("open writer").into_raw_fd(),
        )
        .expect("bridge");

        App::new(bridge, PathBuf::from("/tmp"), true)
    }

    fn test_app_with_writer(write_path: &std::path::Path) -> App {
        let reader = NamedTempFile::new().expect("reader temp file");
        let bridge = NdjsonBridge::from_fds(
            File::open(reader.path()).expect("open reader").into_raw_fd(),
            OpenOptions::new()
                .write(true)
                .open(write_path)
                .expect("open writer")
                .into_raw_fd(),
        )
        .expect("bridge");

        App::new(bridge, PathBuf::from("/tmp"), true)
    }

    fn ctrl_g_key_event() -> KeyEvent {
        KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL)
    }

    fn prompt_slash(name: &str) -> SlashCatalogEntry {
        SlashCatalogEntry {
            name: name.into(),
            description: format!("{name} description"),
            usage: None,
            kind: SlashCatalogKind::Prompt,
        }
    }

    fn direct_slash(name: &str) -> SlashCatalogEntry {
        SlashCatalogEntry {
            name: name.into(),
            description: format!("{name} description"),
            usage: None,
            kind: SlashCatalogKind::Direct,
        }
    }

    #[test]
    fn hello_sets_model_without_overwriting_transient_status() {
        let mut app = test_app();

        app.handle_host_event(HostEvent::Hello {
            protocol_version: 1,
            session_id: "session-1".into(),
            model: "anthropic:claude-sonnet-4-6".into(),
            cwd: "/workspace/project".into(),
        });

        assert_eq!(app.model.as_deref(), Some("anthropic:claude-sonnet-4-6"));
        assert_eq!(app.footer.model_text, "anthropic:claude-sonnet-4-6");
        assert_eq!(app.status_text, "Ready");
        assert_eq!(app.footer.status_text, "Ready");
        assert_eq!(app.cwd, PathBuf::from("/workspace/project"));
    }

    #[test]
    fn footer_summary_populates_persistent_summary_without_replacing_transient_status() {
        let mut app = test_app();

        app.handle_host_event(HostEvent::Status {
            text: "Session restored".into(),
        });
        app.handle_host_event(HostEvent::FooterSummary {
            text: "completed • verified • 1 provider • 2 tools • 18s".into(),
        });

        assert_eq!(app.status_text, "Session restored");
        assert_eq!(
            app.turn_summary_text.as_deref(),
            Some("completed • verified • 1 provider • 2 tools • 18s")
        );
        assert_eq!(app.footer.status_text, "Session restored");
        assert_eq!(
            app.footer.turn_summary_text.as_deref(),
            Some("completed • verified • 1 provider • 2 tools • 18s")
        );
    }

    #[test]
    fn dispatch_submit_prompt_sets_busy_and_turn_completed_clears_it_without_losing_summary_or_model() {
        let writer = NamedTempFile::new().expect("writer temp file");
        let mut app = test_app_with_writer(writer.path());

        app.handle_host_event(HostEvent::Hello {
            protocol_version: 1,
            session_id: "session-1".into(),
            model: "anthropic:claude-sonnet-4-6".into(),
            cwd: "/workspace/project".into(),
        });
        app.handle_host_event(HostEvent::FooterSummary {
            text: "completed • verified • 1 provider • 2 tools • 18s".into(),
        });
        app.handle_host_event(HostEvent::Status {
            text: "Working on request".into(),
        });

        app.dispatch_submit(SubmitAction::Prompt("hello from test".into()))
            .expect("dispatch prompt");

        assert!(app.composer.busy);
        assert!(app.footer.status_text.contains("Working · anthropic:claude-sonnet-4-6"));
        assert_eq!(
            app.footer.turn_summary_text.as_deref(),
            Some("completed • verified • 1 provider • 2 tools • 18s")
        );
        assert_eq!(app.footer.model_text, "anthropic:claude-sonnet-4-6");

        app.handle_host_event(HostEvent::AssistantCompleted {
            turn_id: "turn-1".into(),
            message_id: "assistant-1".into(),
            text: "done".into(),
        });
        assert!(app.composer.busy);
        assert!(app.footer.status_text.contains("Working · anthropic:claude-sonnet-4-6"));
        assert_eq!(
            app.footer.turn_summary_text.as_deref(),
            Some("completed • verified • 1 provider • 2 tools • 18s")
        );
        assert_eq!(app.footer.model_text, "anthropic:claude-sonnet-4-6");

        app.handle_host_event(HostEvent::TurnCompleted {
            turn_id: "turn-1".into(),
            stop_reason: "end_turn".into(),
            final_answer: "done".into(),
        });
        assert!(!app.composer.busy);
        assert_eq!(app.footer.status_text, "Working on request");
        assert_eq!(
            app.footer.turn_summary_text.as_deref(),
            Some("completed • verified • 1 provider • 2 tools • 18s")
        );
        assert_eq!(app.footer.model_text, "anthropic:claude-sonnet-4-6");
    }

    #[test]
    fn dispatch_submit_prompt_does_not_leave_busy_set_when_send_fails() {
        let mut app = test_app_with_writer(std::path::Path::new("/dev/full"));

        app.dispatch_submit(SubmitAction::Prompt("hello from test".into()))
            .expect_err("dispatch should fail");

        assert!(!app.composer.busy);
        assert!(!app.footer.busy);
        assert_eq!(app.footer.status_text, "Ready");
    }

    #[test]
    fn dispatch_submit_prompt_slash_sets_busy_on_success() {
        let writer = NamedTempFile::new().expect("writer temp file");
        let mut app = test_app_with_writer(writer.path());
        app.slash_catalog = vec![prompt_slash("plan")];

        app.dispatch_submit(SubmitAction::Slash {
            command: "plan".into(),
            args_text: Some("next steps".into()),
        })
        .expect("dispatch prompt slash");

        assert!(app.composer.busy);
        assert!(app.footer.busy);
        assert_eq!(app.footer.status_text, "⠋ Working · agent");
    }

    #[test]
    fn dispatch_submit_shell_does_not_set_busy_on_success() {
        let writer = NamedTempFile::new().expect("writer temp file");
        let mut app = test_app_with_writer(writer.path());

        app.dispatch_submit(SubmitAction::Shell {
            command: "ls".into(),
            args: vec!["-la".into()],
        })
        .expect("dispatch shell");

        assert!(!app.composer.busy);
        assert!(!app.footer.busy);
        assert_eq!(app.footer.status_text, "Ready");
    }

    #[test]
    fn dispatch_submit_direct_slash_does_not_set_busy_on_success() {
        let writer = NamedTempFile::new().expect("writer temp file");
        let mut app = test_app_with_writer(writer.path());
        app.slash_catalog = vec![direct_slash("help")];

        app.dispatch_submit(SubmitAction::Slash {
            command: "help".into(),
            args_text: None,
        })
        .expect("dispatch direct slash");

        assert!(!app.composer.busy);
        assert!(!app.footer.busy);
        assert_eq!(app.footer.status_text, "Ready");
    }

    #[test]
    fn error_event_clears_busy_without_losing_summary_or_model() {
        let writer = NamedTempFile::new().expect("writer temp file");
        let mut app = test_app_with_writer(writer.path());

        app.handle_host_event(HostEvent::Hello {
            protocol_version: 1,
            session_id: "session-1".into(),
            model: "anthropic:claude-sonnet-4-6".into(),
            cwd: "/workspace/project".into(),
        });
        app.handle_host_event(HostEvent::FooterSummary {
            text: "completed • verified • 1 provider • 2 tools • 18s".into(),
        });
        app.handle_host_event(HostEvent::Status {
            text: "Working on request".into(),
        });
        app.dispatch_submit(SubmitAction::Prompt("hello from test".into()))
            .expect("dispatch prompt");

        app.handle_host_event(HostEvent::Error {
            text: "bridge failed".into(),
        });

        assert!(!app.composer.busy);
        assert_eq!(app.footer.status_text, "bridge failed");
        assert_eq!(
            app.footer.turn_summary_text.as_deref(),
            Some("completed • verified • 1 provider • 2 tools • 18s")
        );
        assert_eq!(app.footer.model_text, "anthropic:claude-sonnet-4-6");
    }

    #[test]
    fn scrolled_override_reverts_to_busy_and_default_status_when_returning_to_bottom() {
        let writer = NamedTempFile::new().expect("writer temp file");
        let mut app = test_app_with_writer(writer.path());

        app.handle_host_event(HostEvent::Hello {
            protocol_version: 1,
            session_id: "session-1".into(),
            model: "anthropic:claude-sonnet-4-6".into(),
            cwd: "/workspace/project".into(),
        });
        app.handle_host_event(HostEvent::FooterSummary {
            text: "completed • verified • 1 provider • 2 tools • 18s".into(),
        });
        app.handle_host_event(HostEvent::Status {
            text: "Queued".into(),
        });
        app.dispatch_submit(SubmitAction::Prompt("hello from test".into()))
            .expect("dispatch prompt");

        app.transcript.scroll_up(1);
        app.update_footer();
        assert_eq!(app.footer.status_text, "Scrolled");
        assert_eq!(
            app.footer.turn_summary_text.as_deref(),
            Some("completed • verified • 1 provider • 2 tools • 18s")
        );
        assert_eq!(app.footer.model_text, "anthropic:claude-sonnet-4-6");

        app.transcript.scroll_to_bottom();
        app.update_footer();
        assert!(app.footer.status_text.contains("Working · anthropic:claude-sonnet-4-6"));
        assert_eq!(
            app.footer.turn_summary_text.as_deref(),
            Some("completed • verified • 1 provider • 2 tools • 18s")
        );
        assert_eq!(app.footer.model_text, "anthropic:claude-sonnet-4-6");

        app.handle_host_event(HostEvent::TurnCompleted {
            turn_id: "turn-1".into(),
            stop_reason: "end_turn".into(),
            final_answer: "done".into(),
        });
        app.transcript.scroll_up(1);
        app.update_footer();
        assert_eq!(app.footer.status_text, "Scrolled");

        app.transcript.scroll_to_bottom();
        app.update_footer();
        assert_eq!(app.footer.status_text, "Queued");
        assert_eq!(
            app.footer.turn_summary_text.as_deref(),
            Some("completed • verified • 1 provider • 2 tools • 18s")
        );
        assert_eq!(app.footer.model_text, "anthropic:claude-sonnet-4-6");
    }

    #[test]
    fn ctrl_g_warning_is_cleared_before_host_status_renders() {
        let mut app = test_app();

        app.transcript.scroll_up(1);
        app.handle_key_event(ctrl_g_key_event())
            .expect("ctrl+g should be handled");
        assert_eq!(app.footer.status_text, "Scrolled");
        assert!(app.terminal_status_text.is_some());

        app.transcript.scroll_to_bottom();
        app.handle_host_event(HostEvent::Status {
            text: "Fresh host status".into(),
        });

        assert_eq!(app.footer.status_text, "Fresh host status");
        assert_eq!(app.terminal_status_text, None);
    }

    #[test]
    fn ctrl_g_warning_is_cleared_before_host_error_renders_and_busy_clears() {
        let writer = NamedTempFile::new().expect("writer temp file");
        let mut app = test_app_with_writer(writer.path());

        app.dispatch_submit(SubmitAction::Prompt("hello from test".into()))
            .expect("dispatch prompt");
        app.handle_key_event(ctrl_g_key_event())
            .expect("ctrl+g should be handled");
        assert!(app.composer.busy);
        assert_eq!(app.footer.status_text, "⠋ Working · agent");
        assert!(app.terminal_status_text.is_some());

        app.handle_host_event(HostEvent::Error {
            text: "Host failed".into(),
        });

        assert_eq!(app.footer.status_text, "Host failed");
        assert!(!app.composer.busy);
        assert!(!app.footer.busy);
        assert_eq!(app.terminal_status_text, None);
    }

    #[test]
    fn terminal_local_status_survives_plain_update_footer_tick() {
        let mut app = test_app();

        app.handle_key_event(ctrl_g_key_event())
            .expect("ctrl+g should be handled");
        let terminal_status = app.footer.status_text.clone();

        app.update_footer();

        assert_eq!(
            app.terminal_status_text.as_deref(),
            Some(terminal_status.as_str())
        );
        assert_eq!(app.footer.status_text, terminal_status);
    }

    #[test]
    fn session_loaded_clears_terminal_local_status_and_shows_session_status() {
        let mut app = test_app();

        app.handle_key_event(ctrl_g_key_event())
            .expect("ctrl+g should be handled");
        assert!(app.terminal_status_text.is_some());

        app.handle_host_event(HostEvent::SessionLoaded {
            session_id: "session-1".into(),
            restored: true,
            history_summary: None,
        });

        assert_eq!(app.terminal_status_text, None);
        assert_eq!(app.status_text, "Session restored");
        assert_eq!(app.footer.status_text, "Session restored");
    }

    #[test]
    fn prompt_slash_busy_clears_on_turn_completed() {
        let writer = NamedTempFile::new().expect("writer temp file");
        let mut app = test_app_with_writer(writer.path());
        app.slash_catalog = vec![prompt_slash("plan")];

        app.handle_host_event(HostEvent::Status {
            text: "Queued".into(),
        });
        app.dispatch_submit(SubmitAction::Slash {
            command: "plan".into(),
            args_text: Some("next steps".into()),
        })
        .expect("dispatch prompt slash");
        assert!(app.composer.busy);
        assert_eq!(app.footer.status_text, "⠋ Working · agent");

        app.handle_host_event(HostEvent::TurnCompleted {
            turn_id: "turn-1".into(),
            stop_reason: "end_turn".into(),
            final_answer: "done".into(),
        });

        assert!(!app.composer.busy);
        assert!(!app.footer.busy);
        assert_eq!(app.footer.status_text, "Queued");
    }

    #[test]
    fn prompt_slash_busy_clears_on_error() {
        let writer = NamedTempFile::new().expect("writer temp file");
        let mut app = test_app_with_writer(writer.path());
        app.slash_catalog = vec![prompt_slash("plan")];

        app.dispatch_submit(SubmitAction::Slash {
            command: "plan".into(),
            args_text: Some("next steps".into()),
        })
        .expect("dispatch prompt slash");
        assert!(app.composer.busy);
        assert_eq!(app.footer.status_text, "⠋ Working · agent");

        app.handle_host_event(HostEvent::Error {
            text: "Slash failed".into(),
        });

        assert!(!app.composer.busy);
        assert!(!app.footer.busy);
        assert_eq!(app.footer.status_text, "Slash failed");
    }

    #[test]
    fn terminal_local_status_does_not_return_after_busy_and_scrolled_overlays_clear() {
        let writer = NamedTempFile::new().expect("writer temp file");
        let mut app = test_app_with_writer(writer.path());

        app.handle_host_event(HostEvent::Status {
            text: "Host status".into(),
        });
        app.handle_key_event(ctrl_g_key_event())
            .expect("ctrl+g should be handled");
        assert_eq!(
            app.footer.status_text,
            "External editor mode is not supported in this build. Keep typing here or paste content directly."
        );

        app.dispatch_submit(SubmitAction::Prompt("hello from test".into()))
            .expect("dispatch prompt");
        assert_eq!(app.footer.status_text, "⠋ Working · agent");

        app.transcript.scroll_up(1);
        app.update_footer();
        assert_eq!(app.footer.status_text, "Scrolled");

        app.handle_host_event(HostEvent::TurnCompleted {
            turn_id: "turn-1".into(),
            stop_reason: "end_turn".into(),
            final_answer: "done".into(),
        });
        assert_eq!(app.footer.status_text, "Scrolled");

        app.transcript.scroll_to_bottom();
        app.update_footer();
        assert_eq!(app.footer.status_text, "Host status");
    }
}

