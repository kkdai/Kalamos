use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorKind {
    NotFound,
    AlreadyExists,
    PermissionDenied,
    InvalidPath,
    Io,
    Watch,
    Parse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[error("{kind:?}: {message}")]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_key: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub message_args: BTreeMap<String, String>,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            message_key: None,
            message_args: BTreeMap::new(),
        }
    }

    /// A shared dictionary key for UI display. Keep `message` for diagnostics.
    pub fn with_message_key(mut self, key: &str) -> Self {
        self.message_key = Some(key.into());
        self
    }

    pub fn with_message_arg(mut self, name: &str, value: impl ToString) -> Self {
        self.message_args.insert(name.into(), value.to_string());
        self
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }

    pub fn invalid_path(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidPath, message)
    }

    pub fn parse(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Parse, message)
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        let kind = match err.kind() {
            std::io::ErrorKind::NotFound => ErrorKind::NotFound,
            std::io::ErrorKind::AlreadyExists => ErrorKind::AlreadyExists,
            std::io::ErrorKind::PermissionDenied => ErrorKind::PermissionDenied,
            std::io::ErrorKind::InvalidInput => ErrorKind::InvalidPath,
            std::io::ErrorKind::InvalidData => ErrorKind::Parse,
            _ => ErrorKind::Io,
        };
        Self::new(kind, err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self::parse(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_app_error_matching_api_contract() {
        let err = AppError::not_found("missing file");
        let val = serde_json::to_value(&err).expect("serialize AppError");
        assert_eq!(val["kind"], "NotFound");
        assert_eq!(val["message"], "missing file");
        assert!(val.get("messageKey").is_none());
        assert!(val.get("messageArgs").is_none());
        assert_eq!(serde_json::from_value::<AppError>(val).unwrap(), err);

        let kinds = [
            (ErrorKind::NotFound, "NotFound"),
            (ErrorKind::AlreadyExists, "AlreadyExists"),
            (ErrorKind::PermissionDenied, "PermissionDenied"),
            (ErrorKind::InvalidPath, "InvalidPath"),
            (ErrorKind::Io, "Io"),
            (ErrorKind::Watch, "Watch"),
            (ErrorKind::Parse, "Parse"),
        ];
        for (kind, expected) in kinds {
            let v = serde_json::to_value(&kind).expect("serialize ErrorKind");
            assert_eq!(v, expected);
        }
    }

    #[test]
    fn serializes_localization_metadata_without_changing_the_raw_error() {
        let error = AppError::new(ErrorKind::Io, "逾時（60 秒）")
            .with_message_key("errors.example.timeout")
            .with_message_arg("seconds", 60);
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({
                "kind": "Io",
                "message": "逾時（60 秒）",
                "messageKey": "errors.example.timeout",
                "messageArgs": { "seconds": "60" },
            })
        );
        assert_eq!(error.to_string(), "Io: 逾時（60 秒）");
    }

    #[test]
    fn locale_dictionaries_have_identical_nonempty_key_sets() {
        use std::collections::{BTreeSet, HashMap};

        let zh: HashMap<String, String> =
            serde_json::from_str(include_str!("../../src/i18n/locales/zh-TW.json"))
                .expect("zh-TW.json is a flat string map");
        let en: HashMap<String, String> =
            serde_json::from_str(include_str!("../../src/i18n/locales/en.json"))
                .expect("en.json is a flat string map");

        let zh_keys: BTreeSet<&str> = zh.keys().map(String::as_str).collect();
        let en_keys: BTreeSet<&str> = en.keys().map(String::as_str).collect();
        assert_eq!(zh_keys, en_keys, "zh-TW.json and en.json keys must match exactly");
        for (key, value) in &zh {
            assert!(!value.trim().is_empty(), "zh-TW.json key {key} is empty");
        }
        for (key, value) in &en {
            assert!(!value.trim().is_empty(), "en.json key {key} is empty");
        }
    }

    #[test]
    fn all_with_message_key_calls_exist_in_both_dictionaries() {
        use regex::Regex;
        use std::collections::HashMap;
        use std::fs;
        use std::path::Path;

        let zh: HashMap<String, String> =
            serde_json::from_str(include_str!("../../src/i18n/locales/zh-TW.json"))
                .expect("zh-TW.json is a flat string map");
        let en: HashMap<String, String> =
            serde_json::from_str(include_str!("../../src/i18n/locales/en.json"))
                .expect("en.json is a flat string map");

        let call_re = Regex::new(r"\.with_message_key\(([^)]+)\)").unwrap();
        let literal_re = Regex::new(r#"^\s*"([^"]+)"\s*$"#).unwrap();
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut checked = 0usize;

        for entry in fs::read_dir(&src_dir).expect("read src-tauri/src") {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let raw = fs::read_to_string(&path).expect("read rust source");
            let prod = raw.split("#[cfg(test)]").next().unwrap_or(&raw);
            for caps in call_re.captures_iter(prod) {
                let arg = caps[1].trim();
                let lit = literal_re.captures(arg).unwrap_or_else(|| {
                    panic!(
                        "with_message_key in {} must pass a string literal so keys can be verified, got: {arg}",
                        path.display()
                    )
                });
                let key = &lit[1];
                assert!(
                    zh.get(key).is_some_and(|v| !v.trim().is_empty()),
                    "with_message_key({key:?}) in {} missing from zh-TW.json",
                    path.display()
                );
                assert!(
                    en.get(key).is_some_and(|v| !v.trim().is_empty()),
                    "with_message_key({key:?}) in {} missing from en.json",
                    path.display()
                );
                checked += 1;
            }
        }
        assert!(checked >= 20, "expected to verify >= 20 with_message_key calls, found {checked}");
    }
}
