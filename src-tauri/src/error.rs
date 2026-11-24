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
}
