use crate::protocol::SlashCatalogEntry;

pub fn filter_commands<'a>(catalog: &'a [SlashCatalogEntry], query: &str) -> Vec<&'a SlashCatalogEntry> {
    let normalized = query.trim().trim_start_matches('/').to_ascii_lowercase();
    let mut matches = catalog
        .iter()
        .filter_map(|entry| {
            let name = entry.name.trim_start_matches('/').to_ascii_lowercase();
            let description = entry.description.to_ascii_lowercase();

            let rank = if normalized.is_empty() {
                0
            } else if name == normalized {
                0
            } else if name.starts_with(&normalized) {
                1
            } else if name.contains(&normalized) {
                2
            } else if description.contains(&normalized) {
                3
            } else {
                return None;
            };

            Some((rank, entry))
        })
        .collect::<Vec<_>>();

    matches.sort_by(|(left_rank, left_entry), (right_rank, right_entry)| {
        left_rank
            .cmp(right_rank)
            .then_with(|| left_entry.name.cmp(&right_entry.name))
    });

    matches.into_iter().map(|(_, entry)| entry).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{SlashCatalogEntry, SlashCatalogKind};

    fn catalog() -> Vec<SlashCatalogEntry> {
        vec![
            SlashCatalogEntry {
                name: "/reset".into(),
                description: "Reset the current draft".into(),
                usage: None,
                kind: SlashCatalogKind::Direct,
            },
            SlashCatalogEntry {
                name: "/review".into(),
                description: "Review current work".into(),
                usage: None,
                kind: SlashCatalogKind::Prompt,
            },
            SlashCatalogEntry {
                name: "/status".into(),
                description: "Show status".into(),
                usage: None,
                kind: SlashCatalogKind::Direct,
            },
            SlashCatalogEntry {
                name: "/agents".into(),
                description: "List available agents".into(),
                usage: None,
                kind: SlashCatalogKind::Direct,
            },
        ]
    }

    #[test]
    fn filters_by_name_and_description() {
        let catalog = catalog();
        let filtered = filter_commands(&catalog, "/rev");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "/review");
    }

    #[test]
    fn ranks_exact_and_prefix_matches_before_contains_matches() {
        let catalog = catalog();
        let filtered = filter_commands(&catalog, "/re");
        let names = filtered.into_iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, vec!["/reset", "/review"]);

        let exact = filter_commands(&catalog, "/review");
        let exact_names = exact.into_iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>();
        assert_eq!(exact_names[0], "/review");
    }

    #[test]
    fn keeps_prefix_matches_ahead_of_description_only_matches() {
        let catalog = catalog();
        let filtered = filter_commands(&catalog, "/ag");
        let names = filtered.into_iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, vec!["/agents"]);
    }
}
