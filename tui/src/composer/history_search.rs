#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorySearchMatch {
    pub history_index: usize,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistorySearchState {
    pub query: String,
    pub matches: Vec<HistorySearchMatch>,
    pub selected: usize,
    pub active: bool,
}

impl HistorySearchState {
    pub fn refresh(&mut self, history: &[String]) {
        let previously_selected = self.matches.get(self.selected).map(|entry| entry.history_index);
        let query = self.query.to_ascii_lowercase();
        self.matches = history
            .iter()
            .enumerate()
            .rev()
            .filter(|(_, entry)| query.is_empty() || entry.to_ascii_lowercase().contains(&query))
            .map(|(history_index, entry)| HistorySearchMatch {
                history_index,
                text: entry.clone(),
            })
            .collect();

        if let Some(previously_selected) = previously_selected {
            if let Some(index) = self.matches.iter().position(|entry| entry.history_index == previously_selected) {
                self.selected = index;
                return;
            }
        }

        if self.selected >= self.matches.len() {
            self.selected = 0;
        }
    }
}
