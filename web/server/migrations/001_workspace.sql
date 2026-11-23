CREATE TABLE documents (
    id uuid PRIMARY KEY,
    path text NOT NULL,
    revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    deleted boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    content text NOT NULL
);

CREATE UNIQUE INDEX documents_active_path ON documents (path) WHERE NOT deleted;

CREATE TABLE assets (
    path text PRIMARY KEY,
    mime text NOT NULL,
    data bytea NOT NULL
);

CREATE TABLE settings (
    singleton boolean PRIMARY KEY CHECK (singleton),
    data json NOT NULL CHECK (json_typeof(data) = 'object')
);
