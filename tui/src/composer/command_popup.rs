#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PopupListState {
    pub selected: usize,
    pub visible: bool,
}

impl PopupListState {
    pub fn close(&mut self) {
        self.visible = false;
        self.selected = 0;
    }

    pub fn select_next(&mut self, len: usize) {
        if len == 0 {
            self.selected = 0;
            return;
        }
        self.selected = (self.selected + 1) % len;
    }

    pub fn select_prev(&mut self, len: usize) {
        if len == 0 {
            self.selected = 0;
            return;
        }
        self.selected = if self.selected == 0 { len - 1 } else { self.selected - 1 };
    }
}
