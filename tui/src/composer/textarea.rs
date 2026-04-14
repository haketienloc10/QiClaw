#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextAreaState {
    pub text: String,
    pub cursor: usize,
}

impl TextAreaState {
    pub fn insert_char(&mut self, ch: char) {
        self.text.insert(self.cursor, ch);
        self.cursor += ch.len_utf8();
    }

    #[cfg(test)]
    pub fn insert_str(&mut self, value: &str) {
        self.text.insert_str(self.cursor, value);
        self.cursor += value.len();
    }

    pub fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }

        let prev = self.text[..self.cursor]
            .char_indices()
            .last()
            .map(|(index, _)| index)
            .unwrap_or(0);
        self.text.replace_range(prev..self.cursor, "");
        self.cursor = prev;
    }

    pub fn move_left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        self.cursor = self.text[..self.cursor]
            .char_indices()
            .last()
            .map(|(index, _)| index)
            .unwrap_or(0);
    }

    pub fn move_right(&mut self) {
        if self.cursor >= self.text.len() {
            return;
        }
        let next = self.text[self.cursor..]
            .char_indices()
            .nth(1)
            .map(|(index, _)| self.cursor + index)
            .unwrap_or(self.text.len());
        self.cursor = next;
    }

    pub fn set_text(&mut self, value: String) {
        self.cursor = value.len();
        self.text = value;
    }

    pub fn current_token(&self) -> &str {
        let left = &self.text[..self.cursor];
        if left.chars().last().is_some_and(char::is_whitespace) {
            return "";
        }
        left.split_whitespace().last().unwrap_or(left)
    }

    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_insert_backspace_and_token_lookup() {
        let mut area = TextAreaState::default();
        area.insert_str("/mod");
        area.insert_char('e');
        area.backspace();

        assert_eq!(area.text, "/mod");
        assert_eq!(area.current_token(), "/mod");
    }
}
