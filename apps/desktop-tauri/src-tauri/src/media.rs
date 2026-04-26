//! Native filesystem media bridge for the Tauri desktop shell.
//!
//! The Node sidecar already owns the authoritative SQLite metadata. These
//! commands provide a local fast path for desktop renderers by using the same
//! content-addressed file layout as `createSqliteMediaStore()`:
//! `<data_root>/media/{ab}/{cd}/{sha256}.bin`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{covel_home, UserConfig};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMediaWriteRequest {
    bytes: Vec<u8>,
    mime: String,
    meta: Option<Map<String, Value>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMediaRef {
    id: String,
    mime: String,
    size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<Map<String, Value>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMediaReadResponse {
    id: String,
    size: u64,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMediaExistsResponse {
    exists: bool,
}

#[tauri::command]
pub fn native_media_read(id: String) -> Result<NativeMediaReadResponse, String> {
    validate_media_id(&id)?;
    let path = media_path(&media_root(), &id)?;
    let bytes = fs::read(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    Ok(NativeMediaReadResponse {
        id,
        size: bytes.len() as u64,
        bytes,
    })
}

#[tauri::command]
pub fn native_media_write(req: NativeMediaWriteRequest) -> Result<NativeMediaRef, String> {
    if req.mime.trim().is_empty() {
        return Err("mime is required".to_string());
    }
    let id = sha256_hex(&req.bytes);
    let root = media_root();
    let path = media_path(&root, &id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    if !path.exists() {
        fs::write(&path, &req.bytes).map_err(|e| format!("write {}: {}", path.display(), e))?;
    }
    Ok(NativeMediaRef {
        id,
        mime: req.mime,
        size: req.bytes.len(),
        meta: req.meta,
    })
}

#[tauri::command]
pub fn native_media_exists(id: String) -> Result<NativeMediaExistsResponse, String> {
    validate_media_id(&id)?;
    let path = media_path(&media_root(), &id)?;
    Ok(NativeMediaExistsResponse {
        exists: path.exists(),
    })
}

fn media_root() -> PathBuf {
    let home = covel_home();
    UserConfig::load(&home)
        .resolved_data_root(&home)
        .join("media")
}

fn media_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_media_id(id)?;
    Ok(root
        .join(&id[0..2])
        .join(&id[2..4])
        .join(format!("{id}.bin")))
}

fn validate_media_id(id: &str) -> Result<(), String> {
    if id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Ok(());
    }
    Err("media id must be a lowercase sha256 hex string".to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_lowercase_sha256_ids() {
        let valid = "a".repeat(64);
        assert!(validate_media_id(&valid).is_ok());
        assert!(validate_media_id(&"A".repeat(64)).is_err());
        assert!(validate_media_id("../media").is_err());
        assert!(validate_media_id(&"a".repeat(63)).is_err());
    }

    #[test]
    fn builds_content_addressed_media_path() {
        let id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let path = media_path(Path::new("/tmp/covel-media"), id).unwrap();
        assert_eq!(
            path,
            PathBuf::from("/tmp/covel-media/01/23/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.bin")
        );
    }

    #[test]
    fn hashes_bytes_as_sha256_hex() {
        assert_eq!(
            sha256_hex(b"covel"),
            "5a15fcf0b91df9fdc19d3d675d397fd4f824f88e069a1aabfc24694648d5a92a"
        );
    }
}
