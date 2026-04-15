pub mod cell;
pub mod layout;
pub mod render;

use std::collections::HashSet;

use cell::TranscriptEntry;
use render::render_rows;

use crate::protocol::{HostEvent, TranscriptCellKind};

#[derive(Debug, Clone, Default)]
struct TranscriptRuntimeState {
    active_assistant_turn_id: Option<String>,
    active_tool_call_ids: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct TranscriptState {
    pub entries: Vec<TranscriptEntry>,
    scroll_offset: u16,
    auto_follow: bool,
    runtime: TranscriptRuntimeState,
}

impl Default for TranscriptState {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            scroll_offset: 0,
            auto_follow: true,
            runtime: TranscriptRuntimeState::default(),
        }
    }
}

impl TranscriptState {
    pub fn apply(&mut self, event: &HostEvent) {
        match event {
            HostEvent::TranscriptSeed { cells } => {
                self.entries = cells.iter().cloned().map(TranscriptEntry::from_protocol).collect();
                self.rebuild_runtime_state();
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
                self.runtime.active_assistant_turn_id = Some(turn_id.clone());
            }
            HostEvent::AssistantCompleted {
                turn_id,
                message_id,
                text,
            } => {
                let entry = self.active_assistant_entry(message_id, turn_id);
                entry.text = text.clone();
                entry.streaming = false;
                self.finalize_assistant_turn(turn_id);
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
                self.runtime.active_tool_call_ids.insert(tool_call_id.clone());
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
                self.finalize_tool_call(tool_call_id);
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
                    self.finalize_assistant_turn(turn_id);
                    return;
                }
                let entry = self.assistant_entry_for_turn(turn_id);
                entry.text = final_answer.clone();
                entry.streaming = false;
                self.finalize_assistant_turn(turn_id);
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

    pub fn render_scroll(&self, viewport_height: u16, viewport_width: u16) -> u16 {
        let content_height = self.content_height(viewport_width);
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

    fn content_height(&self, width: u16) -> u16 {
        self.entries
            .iter()
            .map(|entry| render_rows(std::slice::from_ref(entry), "•", width).len() as u16)
            .sum()
    }

    fn active_assistant_entry(&mut self, message_id: &str, turn_id: &str) -> &mut TranscriptEntry {
        let existing_index = self.entries.iter().position(|entry| {
            entry.kind == TranscriptCellKind::Assistant
                && (entry.turn_id.as_deref() == Some(turn_id) || entry.id == message_id)
        });
        if let Some(index) = existing_index {
            let entry = self.entries.get_mut(index).expect("assistant entry by index");
            entry.id = message_id.to_string();
            entry.turn_id = Some(turn_id.to_string());
            return entry;
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

    fn finalize_assistant_turn(&mut self, turn_id: &str) {
        if self.runtime.active_assistant_turn_id.as_deref() == Some(turn_id) {
            self.runtime.active_assistant_turn_id = None;
        }
    }

    fn finalize_tool_call(&mut self, tool_call_id: &str) {
        self.runtime.active_tool_call_ids.remove(tool_call_id);
    }

    fn rebuild_runtime_state(&mut self) {
        self.runtime = TranscriptRuntimeState::default();
        for entry in &self.entries {
            if entry.kind == TranscriptCellKind::Assistant && entry.streaming {
                self.runtime.active_assistant_turn_id = entry.turn_id.clone();
            }
            if entry.kind == TranscriptCellKind::Tool && entry.streaming {
                if let Some(tool_call_id) = &entry.tool_call_id {
                    self.runtime.active_tool_call_ids.insert(tool_call_id.clone());
                }
            }
        }
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
            duration_ms: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{HostEvent, ToolStatus, TranscriptCell, TranscriptCellKind};
    use ratatui::text::Line;

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
                streaming: None,
                turn_id: None,
                tool_call_id: None,
                duration_ms: None,
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
                streaming: None,
                turn_id: None,
                tool_call_id: None,
                duration_ms: None,
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
    fn assistant_completed_reuses_existing_turn_cell_even_if_message_id_changes() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-stream".into(),
            text: "Ch".into(),
        });
        transcript.apply(&HostEvent::AssistantCompleted {
            turn_id: "turn-1".into(),
            message_id: "assistant-final".into(),
            text: "Chào Đại ca, em đây. Cần em làm gì?".into(),
        });

        let assistant_entries: Vec<_> = transcript
            .entries
            .iter()
            .filter(|entry| entry.kind == TranscriptCellKind::Assistant)
            .collect();
        assert_eq!(assistant_entries.len(), 1);
        assert_eq!(assistant_entries[0].text, "Chào Đại ca, em đây. Cần em làm gì?");
        assert_eq!(assistant_entries[0].turn_id.as_deref(), Some("turn-1"));
        assert!(!assistant_entries[0].streaming);
    }

    #[test]
    fn assistant_deltas_merge_into_single_turn_cell_before_completion() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-stream".into(),
            text: "Ch".into(),
        });
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-stream-2".into(),
            text: "ào ".into(),
        });
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-stream-3".into(),
            text: "Đại ca".into(),
        });
        transcript.apply(&HostEvent::AssistantCompleted {
            turn_id: "turn-1".into(),
            message_id: "assistant-final".into(),
            text: "Chào Đại ca".into(),
        });

        let assistant_entries: Vec<_> = transcript
            .entries
            .iter()
            .filter(|entry| entry.kind == TranscriptCellKind::Assistant)
            .collect();
        assert_eq!(assistant_entries.len(), 1);
        assert_eq!(assistant_entries[0].text, "Chào Đại ca");
    }

    #[test]
    fn transcript_seed_reset_clears_partial_assistant_state_before_next_turn() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-stream".into(),
            text: "Ch".into(),
        });
        transcript.apply(&HostEvent::TranscriptSeed { cells: vec![] });
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-2".into(),
            message_id: "assistant-stream-next".into(),
            text: "Xin ".into(),
        });
        transcript.apply(&HostEvent::AssistantCompleted {
            turn_id: "turn-2".into(),
            message_id: "assistant-final-next".into(),
            text: "Xin chào".into(),
        });

        let assistant_entries: Vec<_> = transcript
            .entries
            .iter()
            .filter(|entry| entry.kind == TranscriptCellKind::Assistant)
            .collect();
        assert_eq!(assistant_entries.len(), 1);
        assert_eq!(assistant_entries[0].text, "Xin chào");
        assert_eq!(assistant_entries[0].turn_id.as_deref(), Some("turn-2"));
    }

    #[test]
    fn turn_completed_does_not_duplicate_existing_assistant_turn_cell() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-stream".into(),
            text: "Ch".into(),
        });
        transcript.apply(&HostEvent::AssistantCompleted {
            turn_id: "turn-1".into(),
            message_id: "assistant-final".into(),
            text: "Chào Đại ca.".into(),
        });
        transcript.apply(&HostEvent::TurnCompleted {
            turn_id: "turn-1".into(),
            stop_reason: "completed".into(),
            final_answer: "Chào Đại ca.".into(),
        });

        let assistant_entries: Vec<_> = transcript
            .entries
            .iter()
            .filter(|entry| entry.kind == TranscriptCellKind::Assistant)
            .collect();
        assert_eq!(assistant_entries.len(), 1);
        assert_eq!(assistant_entries[0].text, "Chào Đại ca.");
        assert!(!assistant_entries[0].streaming);
    }

    #[test]
    fn assistant_follow_up_after_tool_stays_after_tool_cells_in_same_turn() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-1".into(),
            text: "Review nhanh theo git diff".into(),
        });
        transcript.apply(&HostEvent::AssistantCompleted {
            turn_id: "turn-1".into(),
            message_id: "assistant-1".into(),
            text: "Review nhanh theo git diff".into(),
        });
        transcript.apply(&HostEvent::ToolStarted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "git".into(),
            label: "git diff --stat".into(),
        });
        transcript.apply(&HostEvent::ToolCompleted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "git".into(),
            status: ToolStatus::Success,
            result_preview: "1 file changed".into(),
            duration_ms: None,
        });
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-1".into(),
            text: "Kết luận".into(),
        });
        transcript.apply(&HostEvent::AssistantCompleted {
            turn_id: "turn-1".into(),
            message_id: "assistant-1".into(),
            text: "Kết luận".into(),
        });
        transcript.apply(&HostEvent::TurnCompleted {
            turn_id: "turn-1".into(),
            stop_reason: "completed".into(),
            final_answer: "Kết luận".into(),
        });

        assert_eq!(transcript.entries.len(), 2);
        assert_eq!(transcript.entries[0].kind, TranscriptCellKind::Assistant);
        assert_eq!(transcript.entries[0].text, "Kết luận");
        assert_eq!(transcript.entries[1].kind, TranscriptCellKind::Tool);
        assert_eq!(transcript.entries[1].text, "1 file changed");
    }

    #[test]
    fn empty_first_chunk_does_not_leave_orphan_partial_assistant_cell() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-stream".into(),
            text: "".into(),
        });
        transcript.apply(&HostEvent::AssistantCompleted {
            turn_id: "turn-1".into(),
            message_id: "assistant-final".into(),
            text: "Chào Đại ca.".into(),
        });

        let assistant_entries: Vec<_> = transcript
            .entries
            .iter()
            .filter(|entry| entry.kind == TranscriptCellKind::Assistant)
            .collect();
        assert_eq!(assistant_entries.len(), 1);
        assert_eq!(assistant_entries[0].text, "Chào Đại ca.");
        assert!(!assistant_entries[0].streaming);
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
        assert_eq!(transcript.entries[0].title.as_deref(), Some("git status"));
        assert_eq!(transcript.entries[0].duration_ms, Some(42));
        assert_eq!(transcript.entries[0].text, "permission denied");
        assert!(!transcript.entries[0].streaming);
        assert!(transcript.runtime.active_tool_call_ids.is_empty());
    }

    #[test]
    fn tool_completed_reuses_existing_tool_cell_for_same_tool_call_id() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::ToolStarted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "shell".into(),
            label: "git status --short".into(),
        });
        transcript.apply(&HostEvent::ToolCompleted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "shell".into(),
            status: ToolStatus::Success,
            result_preview: "M src/main.rs".into(),
            duration_ms: Some(12),
        });

        let tool_entries: Vec<_> = transcript
            .entries
            .iter()
            .filter(|entry| entry.kind == TranscriptCellKind::Tool)
            .collect();
        assert_eq!(tool_entries.len(), 1);
        assert_eq!(tool_entries[0].tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(tool_entries[0].title.as_deref(), Some("git status --short"));
        assert_eq!(tool_entries[0].text, "M src/main.rs");
    }

    #[test]
    fn repeated_tool_started_for_same_tool_call_id_does_not_append_duplicate_cell() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::ToolStarted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "shell".into(),
            label: "git status --short".into(),
        });
        transcript.apply(&HostEvent::ToolStarted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "shell".into(),
            label: "git status --short".into(),
        });
        transcript.apply(&HostEvent::ToolCompleted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "shell".into(),
            status: ToolStatus::Success,
            result_preview: "done".into(),
            duration_ms: None,
        });

        let tool_entries: Vec<_> = transcript
            .entries
            .iter()
            .filter(|entry| entry.kind == TranscriptCellKind::Tool)
            .collect();
        assert_eq!(tool_entries.len(), 1);
        assert_eq!(tool_entries[0].text, "done");
    }

    #[test]
    fn transcript_seed_reset_clears_active_tool_runtime_state_before_next_tool_run() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::ToolStarted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "shell".into(),
            label: "git status --short".into(),
        });
        transcript.apply(&HostEvent::TranscriptSeed { cells: vec![] });
        transcript.apply(&HostEvent::ToolStarted {
            turn_id: "turn-2".into(),
            tool_call_id: "call-2".into(),
            tool_name: "shell".into(),
            label: "git diff --stat".into(),
        });
        transcript.apply(&HostEvent::ToolCompleted {
            turn_id: "turn-2".into(),
            tool_call_id: "call-2".into(),
            tool_name: "shell".into(),
            status: ToolStatus::Success,
            result_preview: "1 file changed".into(),
            duration_ms: None,
        });

        let tool_entries: Vec<_> = transcript
            .entries
            .iter()
            .filter(|entry| entry.kind == TranscriptCellKind::Tool)
            .collect();
        assert_eq!(tool_entries.len(), 1);
        assert_eq!(tool_entries[0].tool_call_id.as_deref(), Some("call-2"));
        assert_eq!(tool_entries[0].text, "1 file changed");
        assert!(transcript.runtime.active_tool_call_ids.is_empty());
    }

    #[test]
    fn transcript_seed_removes_streaming_entries_and_runtime_state_mid_stream() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-stream".into(),
            text: "Ch".into(),
        });
        transcript.apply(&HostEvent::ToolStarted {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "shell".into(),
            label: "git status --short".into(),
        });

        transcript.apply(&HostEvent::TranscriptSeed { cells: vec![] });

        assert!(transcript.entries.is_empty());
        assert!(transcript.runtime.active_assistant_turn_id.is_none());
        assert!(transcript.runtime.active_tool_call_ids.is_empty());
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
                streaming: None,
                turn_id: None,
                tool_call_id: None,
                duration_ms: None,
            }],
        });

        assert!(transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4, 80), 0);

        transcript.apply(&HostEvent::AssistantDelta {
            turn_id: "turn-1".into(),
            message_id: "assistant-1".into(),
            text: " world".into(),
        });

        assert!(transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4, 80), 0);
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
                streaming: None,
                turn_id: None,
                tool_call_id: None,
                duration_ms: None,
            }],
        });

        assert_eq!(transcript.content_height(80), 0);
        assert_eq!(transcript.render_scroll(1, 80), 0);
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
                streaming: None,
                turn_id: None,
                tool_call_id: None,
                duration_ms: None,
            }],
        });

        assert_eq!(transcript.content_height(80), 5);
        assert_eq!(transcript.render_scroll(3, 80), 2);
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

        assert_eq!(transcript.content_height(80), 2);
        assert_eq!(transcript.render_scroll(1, 80), 1);
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
                streaming: None,
                turn_id: None,
                tool_call_id: None,
                duration_ms: None,
            }],
        });
        transcript.apply(&HostEvent::Status {
            text: "Indexing workspace".into(),
        });

        assert_eq!(transcript.content_height(80), 4);
        assert_eq!(transcript.render_scroll(2, 80), 2);
    }

    #[test]
    fn viewport_width_changes_content_height_and_scroll_budget() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::TranscriptAppend {
            cells: vec![TranscriptCell {
                id: "assistant-1".into(),
                kind: TranscriptCellKind::Assistant,
                text: "Đây là một kết luận rất dài để tái hiện việc viewport hẹp làm transcript bị wrap thành nhiều dòng hơn bình thường".into(),
                title: Some("Assistant".into()),
                tool_name: None,
                is_error: None,
                streaming: None,
                turn_id: None,
                tool_call_id: None,
                duration_ms: None,
            }],
        });

        assert!(transcript.content_height(24) > transcript.content_height(80));
        assert!(transcript.render_scroll(4, 24) > transcript.render_scroll(4, 80));
    }

    #[test]
    fn long_output_keeps_more_than_last_five_lines_visible_when_scrolled() {
        let mut transcript = TranscriptState::default();
        transcript.apply(&HostEvent::TranscriptAppend {
            cells: vec![TranscriptCell {
                id: "assistant-1".into(),
                kind: TranscriptCellKind::Assistant,
                text: (1..=20)
                    .map(|index| format!("line {index}: đây là output dài để test scroll ổn định"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                title: Some("Assistant".into()),
                tool_name: None,
                is_error: None,
                streaming: None,
                turn_id: None,
                tool_call_id: None,
                duration_ms: None,
            }],
        });

        let viewport_width = 24;
        let viewport_height = 8;
        let content_height = transcript.content_height(viewport_width);
        let scroll = transcript.render_scroll(viewport_height, viewport_width);
        let rows = render_rows(&transcript.entries, "•", viewport_width);
        let visible = rows
            .iter()
            .skip(scroll as usize)
            .take(viewport_height as usize)
            .map(Line::to_string)
            .collect::<Vec<_>>();

        assert!(content_height > viewport_height);
        assert!(visible.len() > 1);
        assert!(visible.iter().any(|line| line.contains("line 19:") || line.contains("line 20:")));
        assert!(!visible.iter().all(|line| line.trim().is_empty()));
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
                    streaming: None,
                    turn_id: None,
                    tool_call_id: None,
                    duration_ms: None,
                },
                TranscriptCell {
                    id: "assistant-2".into(),
                    kind: TranscriptCellKind::Assistant,
                    text: "tail".into(),
                    title: Some("Assistant".into()),
                    tool_name: None,
                    is_error: None,
                    streaming: None,
                    turn_id: None,
                    tool_call_id: None,
                    duration_ms: None,
                },
            ],
        });
        transcript
    }

    #[test]
    fn auto_follow_scrolls_to_bottom_for_tall_transcript() {
        let transcript = tall_transcript();

        assert!(transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4, 80), 5);
    }

    #[test]
    fn manual_scroll_up_converts_distance_from_bottom_to_top_offset() {
        let mut transcript = tall_transcript();

        transcript.scroll_up(2);

        assert!(!transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4, 80), 3);
    }

    #[test]
    fn preserves_manual_distance_from_bottom_when_new_events_arrive() {
        let mut transcript = tall_transcript();

        transcript.scroll_up(2);
        assert!(!transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4, 80), 3);

        transcript.apply(&HostEvent::Status {
            text: "still running".into(),
        });

        assert!(!transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4, 80), 5);

        transcript.scroll_down(1);
        assert!(!transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4, 80), 6);

        transcript.scroll_down(1);
        assert!(transcript.is_auto_following());
        assert_eq!(transcript.render_scroll(4, 80), 7);
    }
}
