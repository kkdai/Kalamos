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
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
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
        Self {
            kind,
            message: err.to_string(),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self {
            kind: ErrorKind::Parse,
            message: err.to_string(),
        }
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
}
