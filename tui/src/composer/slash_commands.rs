use crate::protocol::SlashCatalogEntry;

pub fn filter_commands<'a>(catalog: &'a [SlashCatalogEntry], query: &str) -> Vec<&'a SlashCatalogEntry> {
    let normalized = query.trim().trim_start_matches('/').to_ascii_lowercase();
    catalog
        .iter()
        .filter(|entry| {
            normalized.is_empty()
                || entry.name.trim_start_matches('/').to_ascii_lowercase().contains(&normalized)
                || entry.description.to_ascii_lowercase().contains(&normalized)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{SlashCatalogEntry, SlashCatalogKind};

    #[test]
    fn filters_by_name_and_description() {
        let catalog = vec![
            SlashCatalogEntry {
                name: "/status".into(),
                description: "Show status".into(),
                usage: None,
                kind: SlashCatalogKind::Direct,
            },
            SlashCatalogEntry {
                name: "/review".into(),
                description: "Review current work".into(),
                usage: None,
                kind: SlashCatalogKind::Prompt,
            },
        ];

        let filtered = filter_commands(&catalog, "/rev");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "/review");
    }
}
