use tauri_plugin_sql::{Migration, MigrationKind};

/// Returns all database migrations
pub fn migrations() -> Vec<Migration> {
    vec![
        // Migration 1: Create system_prompts table with indexes and triggers
        Migration {
            version: 1,
            description: "create_system_prompts_table",
            sql: include_str!("migrations/system-prompts.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 2: Create chat history tables (conversations and messages)
        Migration {
            version: 2,
            description: "create_chat_history_tables",
            sql: include_str!("migrations/chat-history.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 3: Create Live Suggest session tables
        Migration {
            version: 3,
            description: "create_live_suggest_tables",
            sql: include_str!("migrations/live-suggest.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 4: Add per-session background context to Live Suggest
        Migration {
            version: 4,
            description: "add_live_suggest_context",
            sql: include_str!("migrations/live-suggest-context.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 5: Add an AI-generated summary to Live Suggest sessions
        Migration {
            version: 5,
            description: "add_live_suggest_summary",
            sql: include_str!("migrations/live-suggest-summary.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 6: Add persisted chat Q&A for Live Suggest history sessions
        Migration {
            version: 6,
            description: "add_live_suggest_chat_messages",
            sql: include_str!("migrations/live-suggest-chat.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 7: Add branching support for edited Live Suggest chat turns
        Migration {
            version: 7,
            description: "add_live_suggest_chat_branches",
            sql: include_str!("migrations/live-suggest-chat-branches.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
