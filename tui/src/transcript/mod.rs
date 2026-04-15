pub mod cell;
pub mod layout;
pub mod render;

use cell::TranscriptEntry;
use render::render_rows;

use crate::protocol::{HostEvent, TranscriptCellKind};

#[derive(Debug, Clone)]
pub struct TranscriptState {
    pub entries: Vec<TranscriptEntry>,
    scroll_offset: u16,
    auto_follow: bool,
}

impl Default for TranscriptState {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            scroll_offset: 0,
            auto_follow: true,
        }
    }
}

impl TranscriptState {
    pub fn apply(&mut self, event: &HostEvent) {
        match event {
            HostEvent::TranscriptSeed { cells } => {
                self.entries = cells.iter().cloned().map(TranscriptEntry::from_protocol).collect();
                self.scroll_to_bottom();
            }
            HostEvent::TranscriptAppend { cells } => {
                self.entries
                    .extend(cells.iter().cloned().map(TranscriptEntry::from_protocol));
            }
            HostEvent::AssistantDelta {
                turn_id,
                message_id,
                text,
            } => {
                let entry = self.active_assistant_entry(message_id, turn_id);
                entry.text.push_str(text);
                entry.streaming = true;
            }
            HostEvent::AssistantCompleted {
                turn_id,
                message_id,
                text,
            } => {
                let entry = self.active_assistant_entry(message_id, turn_id);
                entry.text = text.clone();
                entry.streaming = false;
            }
            HostEvent::ToolStarted {
                turn_id,
                tool_call_id,
                tool_name,
                label,
            } => {
                if self.find_tool_entry_mut(tool_call_id).is_none() {
                    self.entries.push(TranscriptEntry::tool_running(
                        tool_call_id.clone(),
                        turn_id.clone(),
                        tool_name.clone(),
                        label.clone(),
                    ));
                }
            }
            HostEvent::ToolCompleted {
                turn_id,
                tool_call_id,
                tool_name,
                status,
                result_preview,
                duration_ms,
            } => {
                let entry = if let Some(existing) = self.find_tool_entry_mut(tool_call_id) {
                    existing
                } else {
                    self.entries.push(TranscriptEntry::tool_running(
                        tool_call_id.clone(),
                        turn_id.clone(),
                        tool_name.clone(),
                        tool_name.clone(),
                    ));
                    self.entries.last_mut().expect("tool entry inserted")
                };
                entry.tool_completed(*status, result_preview, *duration_ms);
            }
            HostEvent::Status { text } => self.push_status("Status", text, false),
            HostEvent::Warning { text } => self.push_status("Warning", text, true),
            HostEvent::Error { text } => self.push_status("Error", text, true),
            HostEvent::TurnCompleted {
                turn_id,
                final_answer,
                ..
            } => {
                if final_answer.trim().is_empty() {
                    return;
                }
                let entry = self.assistant_entry_for_turn(turn_id);
                entry.text = final_answer.clone();
                entry.streaming = false;
            }
            HostEvent::Hello { .. }
            | HostEvent::SessionLoaded { .. }
            | HostEvent::Footer { .. }
            | HostEvent::SlashCatalog { .. } => {}
        }

        if self.auto_follow {
            self.scroll_to_bottom();
        }
    }

    pub fn render_scroll(&self, viewport_height: u16) -> u16 {
        let content_height = self.content_height();
        let max_scroll = content_height.saturating_sub(viewport_height);

        if self.auto_follow {
            max_scroll
        } else {
            max_scroll.saturating_sub(self.scroll_offset.min(max_scroll))
        }
    }

    pub fn is_auto_following(&self) -> bool {
        self.auto_follow
    }

    pub fn scroll_up(&mut self, amount: u16) {
        self.scroll_offset = self.scroll_offset.saturating_add(amount);
        self.auto_follow = false;
    }

    pub fn scroll_down(&mut self, amount: u16) {
        self.scroll_offset = self.scroll_offset.saturating_sub(amount);
        self.auto_follow = self.scroll_offset == 0;
    }

    pub fn scroll_to_bottom(&mut self) {
        self.scroll_offset = 0;
        self.auto_follow = true;
    }

    fn content_height(&self) -> u16 {
        self.entries
            .iter()
            .map(|entry| render_rows(std::slice::from_ref(entry), "•").len() as u16)
            .sum()
    }

    fn active_assistant_entry(&mut self, message_id: &str, turn_id: &str) -> &mut TranscriptEntry {
        let existing_index = self
            .entries
            .iter()
            .position(|entry| entry.id == message_id && entry.kind == TranscriptCellKind::Assistant);
        if let Some(index) = existing_index {
            return self.entries.get_mut(index).expect("assistant entry by index");
        }

        self.entries.push(TranscriptEntry::assistant_streaming(
            message_id.to_string(),
            turn_id.to_string(),
        ));
        self.entries.last_mut().expect("assistant entry inserted")
    }

    fn assistant_entry_for_turn(&mut self, turn_id: &str) -> &mut TranscriptEntry {
        let existing_index = self.entries.iter().position(|entry| {
            entry.kind == TranscriptCellKind::Assistant && entry.turn_id.as_deref() == Some(turn_id)
        });
        if let Some(index) = existing_index {
            return self.entries.get_mut(index).expect("assistant entry by index");
        }

        self.entries.push(TranscriptEntry::assistant_streaming(
            format!("assistant-{turn_id}"),
            turn_id.to_string(),
        ));
        self.entries.last_mut().expect("assistant entry inserted")
    }

    fn find_tool_entry_mut(&mut self, tool_call_id: &str) -> Option<&mut TranscriptEntry> {
        self.entries
            .iter_mut()
            .find(|entry| entry.tool_call_id.as_deref() == Some(tool_call_id))
    }

    fn push_status(&mut self, title: &str, text: &str, is_error: bool) {
        self.entries.push(TranscriptEntry {
            id: format!("status-{}-{}", self.entries.len() + 1, title.to_ascii_lowercase()),
            kind: TranscriptCellKind::Status,
            title: Some(title.into()),
            text: text.into(),
            tool_name: None,
            is_error,
            streaming: false,
            turn_id: None,
            tool_call_id: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{HostEvent, ToolStatus, TranscriptCell, TranscriptCellKind};

    #[test]
    fn replaces_seed_and_appends_cells() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::TranscriptSeed {
            cells: vec![TranscriptCell {
                id: "user-1".into(),
                kind: TranscriptCellKind::User,
                text: "hello".into(),
                title: None,
                tool_name: None,
                is_error: None,
            }],
        });
        transcript.apply(&HostEvent::TranscriptAppend {
            cells: vec![TranscriptCell {
                id: "summary-1".into(),
                kind: TranscriptCellKind::Summary,
                text: "done".into(),
                title: Some("Summary".into()),
                tool_name: None,
                is_error: None,
            }],
        });

        assert_eq!(transcript.entries.len(), 2);
        assert_eq!(transcript.entries[1].kind, TranscriptCellKind::Summary);
    }

    #[test]
    fn updates_assistant_stream_in_place() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-1".into(),
            text: "hel".into(),
        });
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-1".into(),
            text: "lo".into(),
        });
        transcript.apply(&HostEvent::AssistantCompleted {
            turn_id: "turn-1".into(),
            message_id: "assistant-1".into(),
            text: "hello".into(),
        });

        assert_eq!(transcript.entries.len(), 1);
        assert_eq!(transcript.entries[0].text, "hello");
        assert!(!transcript.entries[0].streaming);
    }

    #[test]
    fn updates_tool_running_completed_and_error_states() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::ToolStarted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "shell".into(),
            label: "git status".into(),
        });
        transcript.apply(&HostEvent::ToolCompleted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "shell".into(),
            status: ToolStatus::Error,
            result_preview: "permission denied".into(),
            duration_ms: Some(42),
        });

        assert_eq!(transcript.entries.len(), 1);
        assert!(transcript.entries[0].is_error);
        assert_eq!(transcript.entries[0].title.as_deref(), Some("git status · failed in 42ms"));
        assert_eq!(transcript.entries[0].text, "permission denied");
        assert!(!transcript.entries[0].streaming);
    }

    #[test]
    fn turn_completed_updates_matching_turn_without_overwriting_prior_assistant() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::AssistantCompleted {
            turn_id: "turn-1".into(),
            message_id: "assistant-1".into(),
            text: "first answer".into(),
        });
        transcript.apply(&HostEvent::TurnCompleted {
            turn_id: "turn-2".into(),
            stop_reason: "completed".into(),
            final_answer: "second answer".into(),
        });

        assert_eq!(transcript.entries.len(), 2);
        assert_eq!(transcript.entries[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(transcript.entries[0].text, "first answer");
        assert_eq!(transcript.entries[1].turn_id.as_deref(), Some("turn-2"));
        assert_eq!(transcript.entries[1].text, "second answer");
        assert!(!transcript.entries[1].streaming);
    }

    #[test]
    fn keeps_auto_follow_at_bottom_when_new_events_arrive() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::TranscriptAppend {
            cells: vec![TranscriptCell {
                id: "assistant-1".into(),
                kind: TranscriptCellKind::Assistant,
                text: "hello".into(),
                title: Some("Assistant".into()),
                tool_name: None,
                is_error: None,
            }],
        });

        assert!(transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4), 0);

        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-1".into(),
            text: " world".into(),
        });

        assert!(transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4), 0);
    }

    #[test]
    fn empty_conversation_entry_height_matches_rendered_lines() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::TranscriptAppend {
            cells: vec![TranscriptCell {
                id: "assistant-1".into(),
                kind: TranscriptCellKind::Assistant,
                text: "".into(),
                title: Some("Assistant".into()),
                tool_name: None,
                is_error: None,
            }],
        });

        assert_eq!(transcript.content_height(), 3);
        assert_eq!(transcript.render_scroll(1), 2);
    }

    #[test]
    fn trailing_blank_lines_contribute_to_content_height() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::TranscriptAppend {
            cells: vec![TranscriptCell {
                id: "assistant-1".into(),
                kind: TranscriptCellKind::Assistant,
                text: "a\n\n".into(),
                title: Some("Assistant".into()),
                tool_name: None,
                is_error: None,
            }],
        });

        assert_eq!(transcript.content_height(), 5);
        assert_eq!(transcript.render_scroll(3), 2);
    }

    #[test]
    fn tool_entries_do_not_add_separator_height() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::ToolStarted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "shell".into(),
            label: "git status".into(),
        });
        transcript.apply(&HostEvent::ToolCompleted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "shell".into(),
            status: ToolStatus::Success,
            result_preview: "On branch main".into(),
            duration_ms: None,
        });

        assert_eq!(transcript.content_height(), 2);
        assert_eq!(transcript.render_scroll(1), 1);
    }

    #[test]
    fn mixed_conversation_and_work_log_height_matches_rendered_spacing() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::TranscriptAppend {
            cells: vec![TranscriptCell {
                id: "assistant-1".into(),
                kind: TranscriptCellKind::Assistant,
                text: "hello".into(),
                title: Some("Assistant".into()),
                tool_name: None,
                is_error: None,
            }],
        });
        transcript.apply(&HostEvent::Status {
            text: "Indexing workspace".into(),
        });

        assert_eq!(transcript.content_height(), 5);
        assert_eq!(transcript.render_scroll(2), 3);
    }

    fn tall_transcript() -> TranscriptState {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::TranscriptAppend {
            cells: vec![
                TranscriptCell {
                    id: "assistant-1".into(),
                    kind: TranscriptCellKind::Assistant,
                    text: "line 1\nline 2\nline 3\nline 4\nline 5".into(),
                    title: Some("Assistant".into()),
                    tool_name: None,
                    is_error: None,
                },
                TranscriptCell {
                    id: "assistant-2".into(),
                    kind: TranscriptCellKind::Assistant,
                    text: "tail".into(),
                    title: Some("Assistant".into()),
                    tool_name: None,
                    is_error: None,
                },
            ],
        });
        transcript
    }

    #[test]
    fn auto_follow_scrolls_to_bottom_for_tall_transcript() {
        let transcript = tall_transcript();

        assert!(transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4), 6);
    }

    #[test]
    fn manual_scroll_up_converts_distance_from_bottom_to_top_offset() {
        let mut transcript = tall_transcript();

        transcript.scroll_up(2);

        assert!(!transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4), 4);
    }

    #[test]
    fn preserves_manual_distance_from_bottom_when_new_events_arrive() {
        let mut transcript = tall_transcript();

        transcript.scroll_up(2);
        assert!(!transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4), 4);

        transcript.apply(&HostEvent::Status {
            text: "still running".into(),
        });

        assert!(!transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4), 6);

        transcript.scroll_down(1);
        assert!(!transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4), 7);

        transcript.scroll_down(1);
        assert!(transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4), 8);
    }
}
