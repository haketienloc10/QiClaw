#[derive(Debug, Clone)]
pub struct Spinner {
    frames: &'static [&'static str],
    index: usize,
}

impl Default for Spinner {
    fn default() -> Self {
        Self {
            frames: &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
            index: 0,
        }
    }
}

impl Spinner {
    pub fn tick(&mut self) {
        self.index = (self.index + 1) % self.frames.len();
    }

    pub fn frame(&self) -> &'static str {
        self.frames[self.index]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cycles_frames() {
        let mut spinner = Spinner::default();
        let first = spinner.frame();
        spinner.tick();
        assert_ne!(spinner.frame(), first);
    }
}
