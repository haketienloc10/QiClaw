use crate::protocol::{ToolStatus, TranscriptCell, TranscriptCellKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptEntry {
    pub id: String,
    pub kind: TranscriptCellKind,
    pub title: Option<String>,
    pub text: String,
    pub tool_name: Option<String>,
    pub is_error: bool,
    pub streaming: bool,
    pub turn_id: Option<String>,
    pub tool_call_id: Option<String>,
}

impl TranscriptEntry {
    pub fn from_protocol(cell: TranscriptCell) -> Self {
        Self {
            id: cell.id,
            kind: cell.kind,
            title: cell.title,
            text: cell.text,
            tool_name: cell.tool_name,
            is_error: cell.is_error.unwrap_or(false),
            streaming: false,
            turn_id: None,
            tool_call_id: None,
        }
    }

    pub fn assistant_streaming(message_id: String, turn_id: String) -> Self {
        Self {
            id: message_id,
            kind: TranscriptCellKind::Assistant,
            title: Some("working".into()),
            text: String::new(),
            tool_name: None,
            is_error: false,
            streaming: true,
            turn_id: Some(turn_id),
            tool_call_id: None,
        }
    }

    pub fn tool_running(tool_call_id: String, turn_id: String, tool_name: String, label: String) -> Self {
        Self {
            id: format!("tool-{tool_call_id}"),
            kind: TranscriptCellKind::Tool,
            title: Some(label),
            text: "Running…".into(),
            tool_name: Some(tool_name),
            is_error: false,
            streaming: true,
            turn_id: Some(turn_id),
            tool_call_id: Some(tool_call_id),
        }
    }

    pub fn tool_completed(&mut self, status: ToolStatus, result_preview: &str, duration_ms: Option<u64>) {
        self.streaming = false;
        self.is_error = status == ToolStatus::Error;
        let status_label = match status {
            ToolStatus::Success => "completed",
            ToolStatus::Error => "failed",
        };
        let duration = duration_ms
            .map(|value| format!(" in {value}ms"))
            .unwrap_or_default();
        let detail = self.title.clone().or_else(|| self.tool_name.clone()).unwrap_or_default();
        self.title = if detail.trim().is_empty() {
            Some(format!("{status_label}{duration}"))
        } else {
            Some(format!("{detail} · {status_label}{duration}"))
        };
        self.text = result_preview.trim().to_string();
    }
}
