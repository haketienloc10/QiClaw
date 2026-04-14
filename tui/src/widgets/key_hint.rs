pub fn join_key_hints(width: usize, hints: &[&str]) -> String {
    let mut output = String::new();

    for hint in hints {
        let next = if output.is_empty() {
            (*hint).to_string()
        } else {
            format!("{output} • {hint}")
        };

        if next.chars().count() > width {
            break;
        }

        output = next;
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_on_width_boundary() {
        let line = join_key_hints(18, &["Enter submit", "Tab choose", "Esc close"]);
        assert_eq!(line, "Enter submit");
    }
}
