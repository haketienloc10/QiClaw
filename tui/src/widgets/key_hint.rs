pub fn join_key_hints(width: usize, hints: &[&str]) -> String {
    let mut output = String::new();

    for hint in hints {
        let formatted = format_hint(hint);
        let next = if output.is_empty() {
            formatted
        } else {
            format!("{output} · {formatted}")
        };

        if next.chars().count() > width {
            break;
        }

        output = next;
    }

    output
}

fn format_hint(hint: &str) -> String {
    let trimmed = hint.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut parts = trimmed.splitn(2, ' ');
    let key = parts.next().unwrap_or_default();
    let rest = parts.next().unwrap_or_default().trim();

    if rest.is_empty() {
        format!("[{key}]")
    } else {
        format!("[{key}] {rest}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_on_width_boundary() {
        let line = join_key_hints(18, &["Enter send", "Tab choose", "Esc close"]);
        assert_eq!(line, "[Enter] send");
    }

    #[test]
    fn formats_key_names_as_bracketed_hints() {
        let line = join_key_hints(80, &["Enter send", "Ctrl+R history", "? shortcuts"]);
        assert_eq!(line, "[Enter] send · [Ctrl+R] history · [?] shortcuts");
    }
}
