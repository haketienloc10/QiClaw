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
    should_quit: bool,
}

impl App {
    pub fn new(bridge: NdjsonBridge, cwd: PathBuf) -> Self {
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
            footer: FooterState::default(),
            slash_catalog: Vec::new(),
            cwd,
            spinner: Spinner::default(),
            session_id: None,
            model: None,
            status_text: "Ready".into(),
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
                    self.transcript.render_scroll(layout.transcript.height.saturating_sub(2)),
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
                self.status_text = model.clone();
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
            HostEvent::Status { text }
            | HostEvent::Footer { text }
            | HostEvent::Warning { text } => {
                self.status_text = text.clone();
            }
            HostEvent::Error { text } => {
                self.status_text = text.clone();
                self.composer.set_busy(false);
            }
            HostEvent::TurnCompleted { .. } => {
                self.composer.set_busy(false);
            }
            HostEvent::AssistantCompleted { .. } => {
                self.composer.set_busy(false);
            }
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
                self.status_text = self
                    .composer
                    .editor_warning
                    .clone()
                    .unwrap_or_else(|| "Editor mode unavailable".into());
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
        self.composer.set_busy(should_mark_busy);
        self.bridge.send_action(&frontend)?;
        self.update_footer();
        Ok(())
    }

    fn update_footer(&mut self) {
        self.footer.mode = self.composer.mode;
        self.footer.popup_open = self.composer.popup.visible;
        self.footer.draft_present = !self.composer.textarea.is_empty();
        self.footer.busy = self.composer.busy;
        self.footer.transcript_scrolled = !self.transcript.is_auto_following();

        let mut status_text = if self.status_text.trim().is_empty() {
            self.model.clone().unwrap_or_else(|| "Ready".into())
        } else {
            self.status_text.clone()
        };

        if self.footer.transcript_scrolled {
            status_text = "Scrolled".into();
        } else if self.footer.busy {
            let model = self.model.clone().unwrap_or_else(|| "agent".into());
            status_text = format!("{} Working · {model}", self.spinner.frame());
        }

        self.footer.status_text = status_text;
    }
}
