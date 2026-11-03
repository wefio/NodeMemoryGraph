# Legacy tessera migration

[中文](legacy-migration.zh-CN.md) · [Terms used](legacy-migration.terms.yaml)

On writable open, legacy `anchors` rows and their references migrate in a savepoint. If both tables exist, identical IDs must agree on the seven legacy fields; differing rows or unsupported legacy columns stop migration without changing either table. Nonconflicting rows move to `tesserae`; legacy marker types and `anchorId` attributes become `tessera_ref` and `tesseraId`. The savepoint also repairs markers after an earlier incomplete rename. The legacy table and FTS objects are removed only within that successful migration. The ordinary schema path creates and repairs tessera FTS after the savepoint; it is not part of that savepoint. Read-only open does not migrate.
