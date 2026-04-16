use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptCellKind {
    User,
    Assistant,
    Tool,
    Status,
    Diff,
    Shell,
    Summary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCell {
    pub id: String,
    pub kind: TranscriptCellKind,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlashCatalogKind {
    Direct,
    Prompt,
    State,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCatalogEntry {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<String>,
    pub kind: SlashCatalogKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum HostEvent {
    Hello {
        protocol_version: u32,
        session_id: String,
        model: String,
        cwd: String,
    },
    SessionLoaded {
        restored: bool,
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        history_summary: Option<String>,
    },
    TranscriptSeed {
        cells: Vec<TranscriptCell>,
    },
    TranscriptAppend {
        cells: Vec<TranscriptCell>,
    },
    AssistantDelta {
        turn_id: String,
        message_id: String,
        text: String,
    },
    AssistantCompleted {
        turn_id: String,
        message_id: String,
        text: String,
    },
    ToolStarted {
        turn_id: String,
        tool_call_id: String,
        tool_name: String,
        label: String,
    },
    ToolCompleted {
        turn_id: String,
        tool_call_id: String,
        tool_name: String,
        status: ToolStatus,
        result_preview: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },
    Status {
        text: String,
    },
    Footer {
        text: String,
    },
    FooterSummary {
        text: String,
    },
    Warning {
        text: String,
    },
    Error {
        text: String,
    },
    TurnCompleted {
        turn_id: String,
        stop_reason: String,
        final_answer: String,
    },
    SlashCatalog {
        commands: Vec<SlashCatalogEntry>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Success,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum FrontendAction {
    SubmitPrompt { prompt: String },
    RunSlashCommand {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args_text: Option<String>,
    },
    RunShellCommand {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Vec<String>>,
    },
    RequestStatus,
    ClearSession,
    Quit,
}

pub fn parse_host_event_line(line: &str) -> Result<HostEvent, serde_json::Error> {
    serde_json::from_str(line.trim())
}

pub fn serialize_frontend_action(action: &FrontendAction) -> Result<String, serde_json::Error> {
    serde_json::to_string(action).map(|line| format!("{line}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_event_lines() {
        let event = parse_host_event_line(
            r#"{"type":"tool_completed","turnId":"turn-1","toolCallId":"call-1","toolName":"shell","status":"success","resultPreview":"done","durationMs":12}"#,
        )
        .expect("valid host event");

        assert_eq!(
            event,
            HostEvent::ToolCompleted {
                turn_id: "turn-1".into(),
                tool_call_id: "call-1".into(),
                tool_name: "shell".into(),
                status: ToolStatus::Success,
                result_preview: "done".into(),
                duration_ms: Some(12),
            }
        );
    }

    #[test]
    fn serializes_frontend_actions_as_ndjson() {
        let line = serialize_frontend_action(&FrontendAction::RunShellCommand {
            command: "git".into(),
            args: Some(vec!["status".into(), "--short".into()]),
        })
        .expect("serialize action");

        assert!(line.ends_with('\n'));
        assert!(line.contains("\"type\":\"run_shell_command\""));
    }

    #[test]
    fn parses_footer_summary_host_event_lines() {
        let event = parse_host_event_line(
            r#"{"type":"footer_summary","text":"completed in 2 tool rounds"}"#,
        )
        .expect("valid footer summary host event");

        assert_eq!(
            event,
            HostEvent::FooterSummary {
                text: "completed in 2 tool rounds".into(),
            }
        );
    }

    #[test]
    fn rejects_malformed_lines() {
        let error = parse_host_event_line(r#"{"type":"assistant_delta","turnId":"turn-1"}"#)
            .expect_err("missing fields must fail");

        assert!(error.is_data());
    }
}
